/**
 * ticketdesk/new_item.js — "New item", the one place anything gets filed.
 *
 * BugDesk has two stores, and this is one mask spanning both. One Type select:
 *
 *     Bug · Regression · Chore          →  bugs/BUG-NNNN.md
 *     [Project ·] Epic · Story · Task   →  backlog/{PROJ,EPIC,STORY,TASK}-NNNN.md
 *
 * Project appears in TRACKER mode only — see ./backlog_data.js's TYPES.
 *
 * Picking the type picks the store, and the form follows it: a bug is asked for
 * a severity, a story for a parent and an estimate, an epic for the phase its
 * descendants inherit. Deciding which STORE something belongs in before saying
 * what it is would be backwards — the store is a property of the thing.
 *
 * A PAGE, NOT A DIALOG. Filing something is not a two-second confirmation: you
 * write a description, paste a screenshot into it, go and look the parent up,
 * come back. A modal makes all of that hostile — it traps focus, it cannot sit
 * open beside the thing you are describing, and it cannot be resized to fit a
 * paragraph. So this is a content kind (`new-item`) opening in a tab like any
 * other page, and the description is the same markdown editor the bug mask
 * uses, with the same paste-a-screenshot support.
 */

import { mountTileBreadcrumb } from '../tiling/tile_breadcrumb.js';
import { attachMarkdownEditor } from './md_editor.js';
import { attachTagInput } from './tag_input.js';
import { attachSelect, setRowVisible } from './select_field.js';
import { attachParentPicker } from './item_picker.js';
import {
    HUMAN_AUTHOR, TICKETS, assigneeChoices, createBug, loadData, rememberAssignee,
} from './data.js';
import {
    ITEMS, PHASES, TRACKER, TYPES, TYPE_ICON, TYPE_LABEL,
    createItem, itemRef, loadBacklog, parentTypesFor,
} from './backlog_data.js';

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

/**
 * The Type select. `store` routes the create; `value` is what that store's
 * `type` field ends up holding.
 *
 * "Chore" is a bug whose stored type is `task` — see the note in ./data.js on
 * why the display name differs. It sits in the bug group because that is where
 * the record lives.
 */
const BACKLOG_KIND = (type) => ({
    id: type, label: TYPE_LABEL[type], store: 'backlog', value: type, icon: TYPE_ICON[type],
});

export const KINDS = [
    // NO BUG TYPES IN TRACKER MODE. A tracker has no bug store — it does not
    // live in a code repo at all — so these three could only ever file into a
    // directory that does not exist. `project` is the mirror image: the level a
    // follow-up tracker hangs everything from, and in a plain backlog a menu
    // entry that could only ever file the wrong thing. The store still READS
    // every type either way; this is about what is OFFERED.
    ...(TRACKER ? [BACKLOG_KIND('project')] : [
        { id: 'bug', label: 'Bug', store: 'bugs', value: 'bug', icon: 'bug_report' },
        { id: 'regression', label: 'Regression', store: 'bugs', value: 'regression', icon: 'history' },
        { id: 'chore', label: 'Chore', store: 'bugs', value: 'task', icon: 'build' },
    ]),
    BACKLOG_KIND('epic'),
    BACKLOG_KIND('story'),
    BACKLOG_KIND('task'),
];
const kindById = (id) => KINDS.find((k) => k.id === id) || KINDS[0];

/**
 * Which fields each kind actually has — the one table both the form's
 * visibility and the submit's payload read, so a hidden field can never be sent
 * and a sent field can never be invisible.
 */
export const FIELDS_FOR = {
    bug:        { severity: true },
    regression: { severity: true },
    chore:      { severity: true },
    // A project and an epic carry the milestone label everything below them
    // inherits. Whether either has a PARENT is derived, not asserted: an epic
    // has one only in tracker mode, where a project exists to hold it, and
    // `parentTypesFor` is the single place that says so.
    project:    { phase: true, due: true },
    epic:       { phase: true, points: true, due: true },
    story:      { points: true, due: true },
    task:       { points: true, due: true },
};
const ADAPTIVE = ['severity', 'parent', 'phase', 'points', 'due'];

/**
 * The fields one kind actually has, with `parent` resolved against the
 * hierarchy rules rather than hardcoded a second time here.
 *
 * A Parent row is drawn when something this deployment OFFERS could hold the
 * new record. Both halves matter, and they are why this is derived rather than
 * listed:
 *
 *   - the format says an epic hangs off a project (`parentTypesFor`), so in
 *     tracker mode an epic gets a Parent row without a mode check in the table;
 *   - a plain backlog offers no project type, so filing an epic there would open
 *     a picker onto a level that cannot exist — the row is absent instead.
 *
 * The test is against TYPES, not against what happens to be in the store: chrome
 * that appears and disappears as records are created is chrome nobody can learn.
 * The item page is deliberately more permissive — an EXISTING record shows its
 * Parent control whenever the format allows one, because re-parenting something
 * that was mis-filed has to stay possible in either mode.
 */
export function fieldsFor(kindId) {
    const spec = { ...(FIELDS_FOR[kindId] || {}) };
    const kind = kindById(kindId);
    if (kind.store === 'backlog') {
        spec.parent = parentTypesFor(kind.value).some((t) => TYPES.includes(t));
    }
    return spec;
}

const toList = (v) => String(v ?? '').trim()
    ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : [];

/** Subsystems already in use, across BOTH stores — the vocabulary you are
 *  almost certainly picking from, with typing still allowed for a new one. */
const subsystemOptions = () => Array.from(new Set([
    ...TICKETS.map((t) => t.subsystem),
    ...ITEMS.map((i) => i.subsystem),
].filter(Boolean))).sort();

const setStatus = (msg) => {
    const el = document.getElementById('sim-status');
    if (el) el.textContent = msg;
};

/* ── the page ────────────────────────────────────────────────────── */

export function mountNewItem(host, props, ctx) {
    let kindId = kindById(props?.kind || 'bug').id;
    let parentId = Number(props?.parent) || 0;

    host.innerHTML = `
    <div class="td-page td-ticket">
        <div class="td-banner">${icon('add_circle')} <b>New item</b> — the Type decides which store it lands in.</div>
        <div class="td-mask">
            <section class="td-group">
                <div class="td-group__title">Record</div>
                <div class="td-group__body td-grid2">
                    <div class="td-field"><label class="td-req">Type</label>
                        <select class="ea-tin" data-f="kind"></select></div>
                    <div class="td-field"><label>Assignee</label>
                        <select class="ea-tin" data-f="assignee"></select></div>
                    <div class="td-field td-span2"><label class="td-req">Title</label>
                        <input class="ea-tin" data-f="title"></div>
                    <div class="td-field" data-row="severity"><label>Severity</label>
                        <select class="ea-tin" data-f="severity"></select></div>
                    <div class="td-field" data-row="parent"><label>Parent</label>
                        <input class="ea-tin" data-f="parent"></div>
                    <div class="td-field" data-row="phase"><label>Phase</label>
                        <select class="ea-tin" data-f="phase"></select></div>
                    <div class="td-field" data-row="points"><label>Estimate</label>
                        <input class="ea-tin" data-f="points" placeholder="e.g. 3"></div>
                    <div class="td-field" data-row="due"><label>Target date</label>
                        <input class="ea-tin" type="date" data-f="due"></div>
                    <div class="td-field"><label>Subsystem</label>
                        <select class="ea-tin" data-f="subsystem"></select></div>
                    <div class="td-field td-span2"><label>Labels</label>
                        <input class="ea-tin" data-f="labels"></div>
                </div>
            </section>
            <section class="td-group">
                <div class="td-group__title">Description</div>
                <div class="td-group__body">
                    <textarea class="ea-tin td-area" data-f="description"
                        placeholder="Steps to reproduce, or the outcome this delivers. Paste a screenshot to attach it."></textarea>
                </div>
            </section>
        </div>
    </div>`;

    const $ = (sel) => host.querySelector(sel);
    const fval = (k) => host.querySelector(`[data-f="${k}"]`)?.value?.trim() ?? '';
    const row = (name) => host.querySelector(`[data-row="${name}"]`);

    /* ── controls ────────────────────────────────────────────────── */

    const selects = {};
    selects.kind = attachSelect($('[data-f="kind"]'), {
        options: KINDS.map((k) => ({ value: k.id, label: k.label, icon: k.icon })),
        value: kindId,
        onChange: (v) => { kindId = v; syncFields(); },
    });
    selects.assignee = attachSelect($('[data-f="assignee"]'), {
        optionsFor: assigneeChoices,
        value: '', emptyLabel: 'Unassigned', allowNew: true,
        // Naming somebody who is not on the roster yet ADDS them to it. The
        // alternative is an assignee nobody else's picker offers and no filter
        // matches — a name that exists only in one file.
        onChange: (v) => { rememberAssignee(v); },
    });
    selects.severity = attachSelect($('[data-f="severity"]'), {
        options: ['crash', 'high', 'medium', 'low'], value: 'medium',
    });
    selects.phase = attachSelect($('[data-f="phase"]'), {
        optionsFor: () => PHASES, value: props?.phase || '', allowNew: true,
        emptyLabel: 'No phase',
    });
    selects.subsystem = attachSelect($('[data-f="subsystem"]'), {
        optionsFor: subsystemOptions, value: '', allowNew: true, emptyLabel: 'unsorted',
    });

    const tagInput = attachTagInput(host.querySelector('[data-f="labels"]'), {
        suggestions: Array.from(new Set([
            ...TICKETS.flatMap((t) => t.labels || []),
            ...ITEMS.flatMap((i) => i.labels || []),
        ])).sort(),
    });

    // The same editor the bug mask uses: markdown toolbar, and pasting or
    // dropping an image uploads it and inserts the reference.
    const descEditor = attachMarkdownEditor(host.querySelector('[data-f="description"]'), {
        onStatus: setStatus, minHeight: 220,
    });

    /* ── parent ──────────────────────────────────────────────────────
     * The SHARED control (item_picker.js): a display plus a search button,
     * identical to the one on the item detail page. `typeOf` is read at click
     * time because the Type select above can change after this is built. */

    const parentPicker = attachParentPicker(host.querySelector('[data-f="parent"]'), {
        typeOf: () => kindById(kindId).value,
        value: parentId,
        onChange: (id) => { parentId = id; },
    });

    /* ── field visibility ────────────────────────────────────────── */

    function syncFields() {
        const shown = fieldsFor(kindId);
        for (const f of ADAPTIVE) setRowVisible(row(f), !!shown[f]);
        const title = host.querySelector('[data-f="title"]');
        if (title) {
            title.placeholder = kindById(kindId).store === 'bugs'
                ? 'What is wrong?' : 'What outcome does this deliver?';
        }
    }
    syncFields();

    /* ── actions ─────────────────────────────────────────────────── */

    const actionsEl = ctx?.pageActions || null;
    if (actionsEl) {
        actionsEl.innerHTML = `
            <div class="td-floatactions">
                <button class="ea-btn" data-a="reset">${icon('undo')} Reset</button>
                <button class="ea-btn ea-btn--primary" data-a="create">${icon('add')} Create</button>
            </div>`;
    }

    const create = async () => {
        const title = fval('title');
        if (!title) {
            setStatus('Create failed: a title is required.');
            host.querySelector('[data-f="title"]')?.focus();
            return;
        }
        const chosen = kindById(kindId);
        const shown = fieldsFor(kindId);
        const btn = actionsEl?.querySelector('[data-a="create"]');
        if (btn) btn.disabled = true;
        try {
            let open;
            if (chosen.store === 'bugs') {
                const bug = await createBug({
                    title,
                    type: chosen.value,
                    severity: selects.severity.value() || 'medium',
                    subsystem: selects.subsystem.value() || 'unsorted',
                    assignee: selects.assignee.value() || HUMAN_AUTHOR,
                    labels: toList(fval('labels')),
                    links: [],
                    description: fval('description'),
                });
                await loadData();
                setStatus(`Bug #${bug.id} created.`);
                open = () => ctx.wm?.navigate?.('ticket',
                    { id: `#${bug.id}`, label: `#${bug.id} — ${bug.title}` }, { ctx, dest: 'origin' });
            } else {
                const item = await createItem({
                    title,
                    type: chosen.value,
                    // Only ever send what this kind actually has: a hidden field
                    // must not reach the record.
                    parent: shown.parent ? parentId : 0,
                    phase: shown.phase ? selects.phase.value() : '',
                    points: shown.points ? fval('points') : '',
                    due: shown.due ? fval('due') : '',
                    assignee: selects.assignee.value(),
                    subsystem: selects.subsystem.value() || 'unsorted',
                    labels: toList(fval('labels')),
                    description: fval('description'),
                });
                await loadBacklog();
                setStatus(`${itemRef(item)} created.`);
                open = () => ctx.wm?.navigate?.('item',
                    { id: String(item.id), label: `${itemRef(item)} — ${item.title}` }, { ctx, dest: 'origin' });
            }
            ctx.eventBus?.emit?.('backlog:changed', {});
            // Replace this page with what it made: the mask has done its job,
            // and leaving it open invites filing the same thing twice.
            open?.();
        } catch (err) {
            setStatus(`Create failed: ${err?.message || err}`);
            if (btn) btn.disabled = false;
        }
    };

    const reset = () => {
        host.querySelectorAll('input[data-f], textarea[data-f]').forEach((el) => { el.value = ''; });
        parentPicker.set(0);
        try { tagInput?.setTags([]); } catch { /* no carrier */ }
        selects.assignee.set('');
        selects.severity.set('medium');
        selects.phase.set('');
        selects.subsystem.set('');
        setStatus('Cleared.');
    };

    const onClick = (e) => {
        const act = e.target.closest('[data-a]')?.dataset.a;
        if (act === 'create') create();
        else if (act === 'reset') reset();
    };
    host.addEventListener('click', onClick);
    actionsEl?.addEventListener('click', onClick);

    requestAnimationFrame(() => host.querySelector('[data-f="title"]')?.focus());

    return {
        title: 'New item',
        destroy: () => {
            host.removeEventListener('click', onClick);
            actionsEl?.removeEventListener('click', onClick);
            for (const s of Object.values(selects)) { try { s.destroy(); } catch { /* gone */ } }
            try { parentPicker.destroy(); } catch { /* gone */ }
            try { tagInput?.destroy(); } catch { /* gone */ }
            try { descEditor?.destroy(); } catch { /* gone */ }
        },
    };
}

/** The content kind, wrapped in the standard page shell. */
export function createNewItemContent({ eventBus } = {}) {
    return {
        'new-item': (hostEl, props, ctx) => {
            hostEl.classList.add('twm-page-shell', 'td-shell');
            hostEl.innerHTML = '';
            const crumbSlot = document.createElement('div');
            crumbSlot.className = 'twm-page-shell__breadcrumb';
            const actionsSlot = document.createElement('div');
            actionsSlot.className = 'td-shell__actions';
            const contentSlot = document.createElement('div');
            contentSlot.className = 'twm-page-shell__content';
            hostEl.append(crumbSlot, actionsSlot, contentSlot);
            let crumb = null;
            try {
                crumb = mountTileBreadcrumb('new-item', props, { ...ctx, eventBus });
                crumbSlot.appendChild(crumb.el);
            } catch (err) { console.warn('[bugdesk] breadcrumb failed', err); }
            const ret = mountNewItem(contentSlot, props, { ...ctx, eventBus, pageActions: actionsSlot });
            return {
                title: ret.title,
                destroy: () => { try { crumb?.destroy?.(); } catch { /* gone */ } ret.destroy?.(); },
            };
        },
    };
}

/**
 * Open the New item page in a tab of the tile the caller came from.
 *
 * A tab, not a window and not a modal: it is a page you work in, and it belongs
 * beside whatever prompted you to file something.
 */
export function openNewItem(wm, { kind = '', parent = 0, phase = '', ctx = null } = {}) {
    // The default has to be a kind this deployment actually offers: `bug` in
    // tracker mode would open the mask on a type that is not in its own select.
    const props = { kind: kind || KINDS[0].id, parent, phase, label: 'New item' };
    wm?.openInTabFromContext?.(ctx || {}, 'new-item', props);
}
