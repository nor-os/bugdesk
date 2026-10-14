/**
 * ticketdesk/mass_actions.js — act on every ticked row at once (STORY-0029).
 *
 * A list in FlexDesk's select mode (its header's toggle) ticks rows instead of
 * opening them; while it is on, a bar above the list offers the MASS ACTIONS of
 * what is ticked:
 *
 *   Change assignee      one person, on every record
 *   Change status to…    only a target EVERY ticked record can move to from
 *                        where it is now — its own moves, configured or
 *                        built-in, the ones its page and right-click offer
 *   a custom action      (STORY-0007), offered where every record offers it
 *
 * Which of these a type offers is `workflow.massActions` (Settings ›
 * Workflow); unconfigured, every type offers the first two. A mass action is on
 * the bar only when every ticked record's type offers it.
 *
 * ONE QUESTION, ASKED ONCE. A move that needs a message asks for it once and
 * every record gets it as its status comment; a flow's questions are asked once
 * (the first record asks, the rest reuse the answer) and the flow still runs
 * per record, so its conditions read each record's own fields.
 *
 * PLANNED FIRST, THEN SAVED. Every record's patch is worked out before
 * anything is written, so a cancelled question saves nothing anywhere. The
 * saves then go one by one; one that fails is reported by name and the rest
 * still land.
 */

import { HUMAN_AUTHOR, assigneeOptions, esc, fetchBug, humanizeStatus, patchBug } from './data.js';
import { fetchItem, humanizeItemStatus, isGated, patchItem, refinementGaps, stageActions } from './backlog_data.js';
import { bugMovesFor, messagePrompt } from './bug_transitions.js';
import { actionsFor, massActionsOf, movesFor, planMove } from './workflow.js';

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

/* ── the records ───────────────────────────────────────────────────── */

/** A bug row's model (TICKETS) as a mass-action record. */
export const bugRecord = (t) => ({
    store: 'bugs', id: Number(t.bugId), ref: String(t.id), type: t.rawType || 'bug', status: t.rawStatus, model: t,
});

/** A backlog row's model (ITEMS) as a mass-action record. */
export const itemRecord = (i) => ({
    store: 'backlog', id: Number(i.id), ref: String(i.ref), type: i.type, status: i.status, model: i,
});

const statusLabel = (store, s) => (store === 'bugs' ? humanizeStatus(s) : humanizeItemStatus(s));

/** One record's moves, `{label, to, message, flow}` — the same list its page offers. */
export function movesOfRecord(r) {
    if (r.store === 'bugs') return bugMovesFor(r.status, r.type);
    const moves = movesFor('backlog', r.type, r.status, stageActions(r.model || { type: r.type, status: r.status }));
    // A gated move (to `refined`) is offered only to an item that passes the checks.
    return moves.filter((m) => !(isGated(m.to) && r.model && refinementGaps(r.model).length > 0));
}

/* ── what is on offer ──────────────────────────────────────────────── */

/**
 * The targets every record can move to, in the first record's order:
 * `{to, label, store, moves: Map(record → its move)}`. A target any one record
 * cannot reach is not offered. The label is the moves' own when they agree,
 * else "Move to <status>".
 */
export function commonTargets(records) {
    if (!records.length) return [];
    const store = records[0].store;
    if (records.some((r) => r.store !== store)) return [];
    const per = records.map((r) => movesOfRecord(r));
    const out = [];
    for (const first of per[0]) {
        if (out.some((t) => t.to === first.to)) continue;
        const moves = new Map();
        let ok = true;
        records.forEach((r, i) => {
            const m = per[i].find((x) => x.to === first.to);
            if (m) moves.set(r, m); else ok = false;
        });
        if (!ok) continue;
        const labels = new Set([...moves.values()].map((m) => m.label));
        out.push({
            to: first.to, store, moves,
            label: labels.size === 1 ? first.label : `Move to ${statusLabel(store, first.to)}`,
            message: [...moves.values()].some((m) => m.message),
        });
    }
    return out;
}

/**
 * The mass actions on offer for these records: `{key, label, icon}` — each one
 * every record's type offers (`workflow.massActions`), a custom action only
 * where every record offers it in its status.
 */
export function offeredMassActions(records) {
    if (!records.length) return [];
    const lists = records.map((r) => massActionsOf(r.store, r.type));
    const common = lists[0].filter((k) => lists.every((l) => l.includes(k)));
    const out = [];
    for (const key of common) {
        if (key === 'assignee') out.push({ key, label: 'Change assignee', icon: 'person' });
        else if (key === 'status') out.push({ key, label: 'Change status to…', icon: 'swap_horiz' });
        else if (key.startsWith('action:')) {
            const id = key.slice(7);
            const acts = records.map((r) => actionsFor(r.store, r.type, r.status).find((a) => a.id === id));
            if (acts.every(Boolean)) out.push({ key, label: acts[0].label, icon: 'bolt', action: id });
        }
    }
    return out;
}

/* ── asking once ───────────────────────────────────────────────────── */

const formKey = (form) => JSON.stringify([form?.title, (form?.fields || []).map((f) => [f.name, f.label, f.type, f.options])]);

/**
 * `ask` (openForm's shape) that asks each distinct question once and answers
 * every later asking of it from memory. A cancelled question stays cancelled.
 */
export function askOnce(ask) {
    const seen = new Map();
    return (form) => {
        const k = formKey(form);
        if (!seen.has(k)) seen.set(k, Promise.resolve(ask(form)));
        return seen.get(k);
    };
}

/* ── running ───────────────────────────────────────────────────────── */

const defaultAsk = async (form) => {
    const { openForm } = await import('@flexdesk/widgets');
    return openForm(form);
};

const fetchRecord = (r) => (r.store === 'bugs' ? fetchBug(r.id) : fetchItem(r.id));
const saveRecord = (r, patch, actor) => (r.store === 'bugs' ? patchBug(r.id, patch, actor) : patchItem(r.id, patch, actor));

/**
 * Plan every record's patch with `plan(record, full)` (null = cancelled), then
 * save them one by one. Resolves `{cancelled, saved: [record], failed:
 * [{record, error}], skipped: [record]}`; `skipped` had nothing to change.
 */
export async function runMass(records, plan, { actor = HUMAN_AUTHOR, fetch = fetchRecord, save = saveRecord } = {}) {
    const planned = [];
    const failed = [];
    for (const r of records) {
        let full;
        try { full = await fetch(r); } catch (error) { failed.push({ record: r, error }); continue; }
        const patch = await plan(r, full);
        if (patch == null) return { cancelled: true, saved: [], failed: [], skipped: [] };
        planned.push([r, patch]);
    }
    const saved = [];
    const skipped = [];
    for (const [r, patch] of planned) {
        if (!Object.keys(patch).length) { skipped.push(r); continue; }
        try { await save(r, patch, actor); saved.push(r); } catch (error) { failed.push({ record: r, error }); }
    }
    return { cancelled: false, saved, failed, skipped };
}

/** "Changed 4 bugs" / "… — failed: #12 (why)". */
export function describeRun(what, run) {
    if (run.cancelled) return `${what}: cancelled, nothing changed.`;
    const n = run.saved.length;
    const parts = [`${what}: ${n} record${n === 1 ? '' : 's'} changed`];
    if (run.skipped.length) parts.push(`${run.skipped.length} already so`);
    let msg = parts.join(', ') + '.';
    if (run.failed.length) {
        msg += ` Failed: ${run.failed.map(({ record, error }) => `${record.ref} (${error?.message || error})`).join('; ')}.`;
    }
    return msg;
}

/** Change the assignee of every record: asks who once. `io` is runMass's
 *  options (`actor`, and `fetch`/`save` for a test). */
export async function massAssign(records, { ask = defaultAsk, ...io } = {}) {
    const names = assigneeOptions(false, ...records.map((r) => r.model?.assignee));
    const result = await ask({
        title: `Change assignee — ${records.length} record${records.length === 1 ? '' : 's'}`,
        fields: [{ name: 'assignee', label: 'Assignee', type: 'select',
                   options: [{ value: '', label: 'Unassigned' }, ...names.map((n) => ({ value: n, label: n }))] }],
        submitLabel: 'Change assignee',
    });
    if (!result) return describeRun('Change assignee', { cancelled: true });
    const who = String(result.assignee || '').trim();
    const run = await runMass(records, (r, full) => (String(full?.assignee || '') === who ? {} : { assignee: who }), io);
    return describeRun(`Assignee → ${who || 'unassigned'}`, run);
}

/**
 * Move every record to `target` (from commonTargets): its own move each, with
 * the message and the flows' questions asked once.
 */
export async function massMove(records, target, { ask = defaultAsk, ...io } = {}) {
    const once = askOnce(ask);
    let message = null;
    // A bug's move asks what its page would ask ("Close message: what fixed
    // it…") when every ticked bug would be asked the same.
    const asks = new Set(records.map((r) => (r.store === 'bugs' ? messagePrompt(r.status, target.to) : '')));
    const question = asks.size === 1 ? [...asks][0] : '';
    const askMessage = async (prompt) => {
        if (message) return message;
        const r = await once({
            title: `${target.label} — ${records.length} record${records.length === 1 ? '' : 's'}`,
            fields: [{ name: 'message', label: `${prompt || question || 'Message'} — saved on every record`, type: 'textarea', rows: 6, required: true }],
            submitLabel: target.label,
        });
        const text = String(r?.message || '').trim();
        message = text ? { comment: text } : null;
        return message;
    };
    const run = await runMass(records, (r, full) => planMove({
        store: r.store, record: full, move: target.moves.get(r), ask: once, askMessage,
    }), io);
    return describeRun(`${target.label} (${statusLabel(target.store, target.to)})`, run);
}

/** Run a custom action on every record, its questions asked once. */
export async function massAction(records, id, { ask = defaultAsk, ...io } = {}) {
    const act = actionsFor(records[0].store, records[0].type, records[0].status).find((a) => a.id === id);
    if (!act) return 'That action is no longer offered.';
    const once = askOnce(ask);
    const run = await runMass(records, (r, full) => {
        const mine = actionsFor(r.store, r.type, r.status).find((a) => a.id === id) || act;
        return planMove({ store: r.store, record: full, move: { label: mine.label, message: false, flow: mine.flow || null },
                          ask: once, askMessage: async () => null });
    }, io);
    return describeRun(act.label, run);
}

/* ── the bar ───────────────────────────────────────────────────────── */

/**
 * A list's mass-action bar. Put `opts.tableOptions` into the list's
 * createTable() options, then call `attach(table)`.
 *
 * @param {HTMLElement} before  the element the bar is inserted in front of (the table host)
 * @param {object} o
 * @param {(indices:number[], table) => object[]} o.recordsOf  ticked rows → records (bugRecord / itemRecord)
 * @param {(message:string) => void} o.report  the status line
 * @param {() => Promise<void>|void} o.afterChange  reload and repaint after a run
 * @param {string} [o.noun='records']
 */
export function massActionBar(before, { recordsOf, report, afterChange, noun = 'records', toggle = null }) {
    const bar = document.createElement('div');
    bar.className = 'bd-massbar';
    bar.hidden = true;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Mass actions');
    before.before(bar);
    let table = null;
    let busy = false;

    const current = () => (table ? recordsOf(table.getSelection(), table) : []);

    // `toggle`: a labelled button in the page's own bar, beside "Save as
    // filter", doing what the small icon in the table's corner does. The corner
    // icon alone was too easy to miss.
    const paintToggle = () => {
        if (!toggle) return;
        const on = !!table?.isSelectMode?.();
        toggle.hidden = !table?.setSelectMode;
        toggle.setAttribute('aria-pressed', String(on));
        toggle.classList.toggle('ea-btn--primary', on);
        toggle.title = on ? 'Stop selecting' : `Tick several ${noun} and act on them at once`;
        toggle.innerHTML = `${icon(on ? 'close' : 'checklist')} ${on ? 'Done selecting' : 'Select'}`;
    };
    toggle?.addEventListener('click', () => {
        if (table?.setSelectMode) table.setSelectMode(!table.isSelectMode());
    });

    const paint = () => {
        paintToggle();
        // A FlexDesk without select mode (before 0.12.0) draws no toggle: no bar.
        if (!table || !table.isSelectMode?.()) { bar.hidden = true; return; }
        bar.hidden = false;
        const recs = current();
        const offered = offeredMassActions(recs);
        const targets = offered.some((a) => a.key === 'status') ? commonTargets(recs) : [];
        const mixed = recs.length && recs.some((r) => r.store !== recs[0].store);
        bar.innerHTML = `
            <span class="bd-massbar__count">${recs.length ? `${recs.length} ${esc(noun)} selected` : `Tick ${esc(noun)} to act on them`}</span>
            ${offered.map((a) => {
                const off = busy || !recs.length || (a.key === 'status' && !targets.length);
                const why = a.key === 'status' && recs.length && !targets.length
                    ? (mixed ? 'Bugs and backlog items have no status in common' : 'No status every selected record can move to from where it is')
                    : '';
                return `<button type="button" class="ea-btn" data-mass="${esc(a.key)}" ${off ? 'disabled' : ''}
                            ${why ? `title="${esc(why)}"` : ''}>${icon(a.icon)} ${esc(a.label)}</button>`;
            }).join('')}
            <span class="td-spacer"></span>
            <button type="button" class="ea-btn" data-mass-clear ${recs.length ? '' : 'disabled'}>Clear</button>
            <button type="button" class="ea-btn" data-mass-done title="Stop selecting">${icon('close')} Done</button>`;
    };

    const chooseTarget = async (recs) => {
        const targets = commonTargets(recs);
        if (!targets.length) return null;
        const r = await defaultAsk({
            title: `Change status — ${recs.length} ${noun}`,
            fields: [{ name: 'to', label: 'Move every selected record to', type: 'select',
                       options: targets.map((t) => ({ value: t.to, label: `${statusLabel(t.store, t.to)} — ${t.label}${t.message ? ' (asks for a message)' : ''}` })) }],
            submitLabel: 'Continue',
        });
        return r ? targets.find((t) => t.to === r.to) || null : null;
    };

    bar.addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        if (!b || !table || busy) return;
        if (b.hasAttribute('data-mass-done')) { table.setSelectMode(false); return; }
        if (b.hasAttribute('data-mass-clear')) { table.clearSelection(); return; }
        const key = b.dataset.mass;
        const recs = current();
        if (!key || !recs.length) return;
        busy = true;
        paint();
        try {
            let msg = null;
            if (key === 'assignee') msg = await massAssign(recs);
            else if (key === 'status') {
                const target = await chooseTarget(recs);
                msg = target ? await massMove(recs, target) : 'Change status: cancelled, nothing changed.';
            } else if (key.startsWith('action:')) msg = await massAction(recs, key.slice(7));
            if (msg) report(msg);
            if (msg && !/cancelled, nothing changed/.test(msg)) await afterChange?.();
        } catch (err) {
            report(`Mass action failed: ${err?.message || err}`);
        } finally {
            busy = false;
            paint();
        }
    });

    return {
        el: bar,
        tableOptions: {
            selectToggle: true,
            // Outside the mode the selection is the keyboard's highlight, not a
            // pick: the mode starts with nothing ticked.
            onSelectModeChange: (on) => { if (on && table) table.clearSelection(); paint(); },
            onSelectionChange: () => paint(),
        },
        attach(t) { table = t; paint(); },
        refresh: paint,
        destroy() { bar.remove(); table = null; },
    };
}
