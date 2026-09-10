/**
 * ticketdesk/backlog_pages.js — BugDesk's backlog content kinds.
 *
 * Registered kinds:
 *   backlog   the tree/list of epics, stories and tasks (a view at a time)
 *   item      one backlog item: record, children, acceptance criteria, comments
 *
 * plus `mountBacklogRail`, the Backlog half of the left panel (see pages.js's
 * mountTicketNav for the Bugs half and the tab strip that switches them).
 *
 * WHY THIS IS A SEPARATE FILE FROM pages.js. The two stores answer different
 * questions and their pages share almost no logic — a bug queue is something you
 * interrogate (hence the filter AST, the expression editor, the per-column
 * filters), a backlog is something you walk down and refine. What they DO share
 * is the scaffold: `shell()` gives both the same breadcrumb strip, floating
 * action slot and scroll region, and `statusLine()` the same place to report to.
 * Both are imported from pages.js rather than reimplemented.
 *
 * REFINEMENT is the one workflow this page is built around. `refinementGaps()`
 * in ./backlog_data.js is the single definition of "refined enough"; the item
 * page LISTS the unmet rules instead of greying out a button, because "why can't
 * I mark this refined" is the question a disabled control always raises and
 * never answers. skills/backlog/SKILL.md applies the same rules.
 */

import { DataTable } from '../ui/components/data_table.js';
import { openForm } from '../ecoagent/ui/modal.js';
import { renderMarkdown } from './markdown.js';
import { attachMarkdownEditor } from './md_editor.js';
import { attachTagInput } from './tag_input.js';
import { shell, statusLine } from './pages.js';
import { esc, initials, HUMAN_AUTHOR, AGENT_AUTHOR } from './data.js';
import {
    BACKLOG_VIEWS, DEFAULT_VIEW, ITEMS, LADDER, PHASES, TYPES, TYPE_ICON,
    createItem, fetchItem, humanizeItemStatus, itemLabel, itemRef,
    loadBacklog, patchItem, postItemComment, REFINEMENT_RULES, refinementGaps,
    resolveView, rowsFor, stageOf, typeLabelOf,
} from './backlog_data.js';

const md = renderMarkdown;
const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

/** Status pill. `dropped` is deliberately off the ladder and styled as such. */
const statusPill = (status) =>
    `<span class="bd-status bd-status--${esc(status)}">${esc(humanizeItemStatus(status))}</span>`;

const typeGlyph = (type) =>
    `<span class="bd-type bd-type--${esc(type)}" title="${esc(typeLabelOf(type))}">${icon(TYPE_ICON[type] || 'task')}</span>`;

/** "2/3" with a bar, or an italic "none" — an unrefined item having no
 *  criteria is the normal state, not a gap in the data. */
function criteriaCell(done, total) {
    if (!total) return '<span class="bd-crit bd-crit--none">none</span>';
    const pct = Math.round((done / total) * 100);
    return `<span class="bd-crit"><span class="bd-crit__bar"><span class="bd-crit__fill" style="width:${pct}%"></span></span>${done}/${total}</span>`;
}

/* ── the create form ─────────────────────────────────────────────────
 *
 * One form for all three types. `parent` is a combobox over the items that can
 * legally hold this one, pre-filled when you create from a row's "Add child"
 * — which is how most items are born, since an item's place in the tree is
 * usually the reason you are creating it at all. */

const parentOptions = (type) => ITEMS
    // Only a shallower type can be a parent: stories hang off epics, tasks off
    // stories (or an epic directly, when a task needs no story around it).
    // An epic has no parent at all, so it gets an empty list.
    .filter((i) => (type === 'story' ? i.type === 'epic' : type === 'task' ? i.type !== 'task' : false))
    .map((i) => ({ value: String(i.id), label: `${i.ref} — ${i.title}` }));

/**
 * Open the "new backlog item" form and create what it returns.
 * Exported as `openBacklogCreate` for install.js's top-bar New Item button —
 * filing an item is something you do from wherever you are, not only from the
 * backlog page.
 * @returns {Promise<object|null>} the created item, or null if cancelled.
 */
export async function openCreateForm({ type = 'story', parent = 0, phase = '' } = {}) {
    const parents = parentOptions(type);
    const result = await openForm({
        title: `New ${typeLabelOf(type).toLowerCase()}`,
        submitLabel: 'Create',
        fields: [
            { name: 'type', label: 'Type', type: 'select', required: true,
              options: TYPES.map((t) => ({ value: t, label: typeLabelOf(t) })),
              hint: 'Epics hold stories; stories hold tasks.' },
            { name: 'title', label: 'Title', type: 'text', required: true,
              placeholder: 'What outcome does this deliver?' },
            // BOTH fields, always — the Type select above can be changed after
            // this form is built, and a form that showed only the field the
            // INITIAL type wanted silently dropped the parent off every story
            // filed from the "New epic" button. The hints say which applies.
            { name: 'parent', label: 'Parent', type: 'select', create: true,
              options: parentOptions('task'),
              placeholder: parents.length ? 'pick an item…' : 'no parent available yet',
              hint: 'For a story or task. Leave empty to file it loose — refinement is where it gets placed. Ignored for an epic.' },
            { name: 'phase', label: 'Phase', type: 'select', create: true,
              options: PHASES, placeholder: 'e.g. foundation',
              hint: 'For an epic: the milestone it belongs to. Its stories and tasks inherit it, so leave this blank on them.' },
            { name: 'points', label: 'Estimate', type: 'text', placeholder: 'e.g. 3' },
            { name: 'assignee', label: 'Assignee', type: 'select',
              options: ['', HUMAN_AUTHOR, AGENT_AUTHOR] },
            { name: 'description', label: 'Description', type: 'textarea', rows: 5 },
        ],
        defaults: { type, parent: parent ? String(parent) : '', phase, assignee: '' },
    });
    if (!result || !String(result.title || '').trim()) return null;

    // The combobox hands back whatever was typed; "EPIC-0004 — Auth" and "4"
    // both have to resolve to the id 4.
    const parentId = (() => {
        const raw = String(result.parent || '').trim();
        if (!raw) return 0;
        const m = raw.match(/(\d+)/);
        return m ? Number(m[1]) : 0;
    })();

    try {
        const chosen = result.type || type;
        const created = await createItem({
            type: chosen,
            title: String(result.title).trim(),
            // An epic has no parent, and a story/task has no authored phase —
            // it inherits one. Sending either anyway is how the two drift.
            parent: chosen === 'epic' ? 0 : parentId,
            phase: chosen === 'epic' ? String(result.phase || '').trim() : '',
            points: String(result.points || '').trim(),
            assignee: String(result.assignee || '').trim(),
            description: String(result.description || '').trim(),
        });
        await loadBacklog();
        statusLine(`${itemRef(created)} created.`);
        return created;
    } catch (err) {
        statusLine(`Create failed: ${err?.message || err}`);
        return null;
    }
}

/* ── kind: backlog — the tree ────────────────────────────────────── */

const BOARD_HEADERS = ['Item', 'Title', 'Type', 'Status', 'Pts', 'Criteria', 'Assignee', 'Phase', 'Updated'];
/* The column every "act on this row" command reads back. Reference, not id:
   it is the only cell that survives a sort as a stable key into the store. */
const REF_COL = 0;

const boardRow = (i) => [
    i.ref, i.title, i.typeLabel, i.statusLabel, i.points || '',
    i.criteriaTotal ? `${i.criteriaDone}/${i.criteriaTotal}` : '',
    i.assignee, i.phaseLabel, i.updated,
];

function mountBacklogBoard(host, props, ctx) {
    let view = resolveView(props?.view, props?.phase);

    host.innerHTML = `
    <div class="td-page">
        <div class="td-page__bar">
            <span class="td-page__title" data-slot="title">${icon(esc(view.icon))} ${esc(view.label)}</span>
            <span class="td-dim" data-slot="count"></span>
            <span class="td-spacer"></span>
            <label class="td-dim" for="bd-phase">Phase</label>
            <select class="ea-tin" id="bd-phase" data-f="phase"></select>
            <button class="ea-btn" data-a="new-epic">${icon('workspaces')} Epic</button>
            <button class="ea-btn ea-btn--primary" data-a="new-story">${icon('add')} Story</button>
        </div>
        <div class="td-tablehost"></div>
    </div>`;

    const phaseSel = host.querySelector('[data-f="phase"]');
    const renderPhases = () => {
        phaseSel.innerHTML = `<option value="">(all)</option>`
            + PHASES.map((p) => `<option value="${esc(p)}" ${p === view.phase ? 'selected' : ''}>${esc(p)}</option>`).join('');
    };
    renderPhases();

    const openBoard = (p) => {
        if (ctx.wm?.navigate) ctx.wm.navigate('backlog', p, { ctx, dest: 'origin' });
        else ctx.wm?.openInPrimary?.('backlog', p);
    };
    const openItem = (id, opts) => {
        const model = ITEMS.find((x) => Number(x.id) === Number(id));
        const p = { id: String(id), label: itemLabel(model) || `#${id}`, view: view.key };
        if (ctx.wm?.navigate) ctx.wm.navigate('item', p, { ctx, ...opts });
        else ctx.wm?.openInTabFromContext?.(ctx, 'item', p);
    };

    /** Row models keyed by their reference, so a SORTED table can still find the
     *  item behind a row — the row index after a sort is not the store index. */
    let byRef = new Map();

    const rows = () => {
        const list = rowsFor(view);
        byRef = new Map(list.map((i) => [i.ref, i]));
        const countEl = host.querySelector('[data-slot="count"]');
        if (countEl) countEl.textContent = `${list.length} item${list.length === 1 ? '' : 's'}`;
        return list.map(boardRow);
    };

    const menuRefs = (cm) => (cm.selectedRows?.length ? cm.selectedRows : (cm.row ? [cm.row] : []))
        .map((r) => r?.[REF_COL]).filter(Boolean);

    const table = new DataTable(host.querySelector('.td-tablehost'), {
        headers: BOARD_HEADERS,
        rows: rows(),
        pagination: false,
        selectable: true,
        copyable: true,
        sortable: true,
        filterable: true,
        mode: 'compact',
        emptyMessage: 'Nothing in this view',
        contextMenuItems: (cm) => {
            const refs = menuRefs(cm);
            const model = cm.row ? byRef.get(cm.row[REF_COL]) : null;
            return [
                { label: refs.length > 1 ? `Open ${refs.length} items in tabs` : 'Open',
                  icon: 'open_in_new', action: 'open', disabled: !refs.length },
                { label: 'Open in new window', icon: 'web_asset', action: 'open-window', disabled: !model },
                { label: 'Open in split right', icon: 'splitscreen_vertical_add', action: 'open-split-h', disabled: !model },
                { separator: true },
                // A task cannot hold children, so the entry is greyed rather than
                // hidden — the menu keeps one shape whichever row you hit.
                { label: 'Add child…', icon: 'add', action: 'add-child',
                  disabled: !model || model.type === 'task' },
                { separator: true },
                { label: refs.length > 1 ? `Copy ${refs.length} references` : 'Copy reference',
                  icon: 'content_copy', action: 'copy-ref', disabled: !refs.length },
            ];
        },
        onContextMenuAction: async (action, cm) => {
            const refs = menuRefs(cm);
            const model = cm.row ? byRef.get(cm.row[REF_COL]) : null;
            switch (action) {
                case 'open': refs.forEach((r) => { const m = byRef.get(r); if (m) openItem(m.id, { dest: 'origin', newTab: true }); }); break;
                case 'open-window': if (model) openItem(model.id, { dest: 'window' }); break;
                case 'open-split-h': if (model) openItem(model.id, { dest: 'split-h' }); break;
                case 'add-child': {
                    if (!model) break;
                    const created = await openCreateForm({
                        type: model.type === 'epic' ? 'story' : 'task',
                        parent: model.id,
                    });
                    if (created) { table.setData({ rows: rows() }); openItem(created.id, { dest: 'origin', newTab: true }); }
                    break;
                }
                case 'copy-ref':
                    if (refs.length) {
                        try {
                            await navigator.clipboard.writeText(refs.join('\n'));
                            statusLine(`Copied ${refs.length} reference${refs.length === 1 ? '' : 's'}.`);
                        } catch (err) {
                            statusLine(`Copy failed: ${err?.message || err}`);
                        }
                    }
                    break;
            }
        },
        renderCell: (td, value, colIdx, rowIdx, row) => {
            const model = byRef.get(row[REF_COL]);
            if (colIdx === REF_COL) {
                td.innerHTML = `<span class="bd-item__ref">${esc(value)}</span>`;
                return true;
            }
            if (colIdx === 1) {
                // The hierarchy IS this indent — the bridge hands rows back in
                // tree order, so depth is the only thing the client adds.
                const depth = model?.depth || 0;
                td.innerHTML = `<span class="bd-item${model?.context ? ' bd-item--context' : ''}"
                    style="padding-left:${depth * 14}px">${typeGlyph(model?.type || 'task')}<span class="bd-item__title">${esc(value)}</span></span>`;
                return true;
            }
            if (colIdx === 3) { td.innerHTML = statusPill(model?.status || 'draft'); return true; }
            if (colIdx === 5) {
                td.innerHTML = criteriaCell(model?.criteriaDone || 0, model?.criteriaTotal || 0);
                return true;
            }
            return false;
        },
        onRowClick: (rowIdx, row, ev) => {
            if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) return;
            const model = byRef.get(row[REF_COL]);
            if (model) openItem(model.id, { dest: 'origin', newTab: true });
        },
    });
    table.render();
    requestAnimationFrame(() => { if (host.isConnected) table.focus(); });

    phaseSel.addEventListener('change', () => openBoard({ view: view.key, phase: phaseSel.value }));
    host.querySelector('[data-a="new-epic"]').addEventListener('click', async () => {
        const created = await openCreateForm({ type: 'epic', phase: view.phase });
        if (created) { renderPhases(); table.setData({ rows: rows() }); }
    });
    host.querySelector('[data-a="new-story"]').addEventListener('click', async () => {
        const created = await openCreateForm({ type: 'story' });
        if (created) table.setData({ rows: rows() });
    });

    // An edit made on an item page changes what this table shows. The bus event
    // is emitted by the item page after every successful write.
    //
    // NOTE the handle: EventBus.on() returns { id, dispose } and off() takes
    // THAT, not (name, handler) — a call shaped like removeEventListener finds
    // no listener id, returns false and leaves the subscription in place.
    const sub = _eventBus?.on?.('backlog:changed',
        () => { renderPhases(); table.setData({ rows: rows() }); });

    return {
        title: view.label,
        destroy: () => {
            sub?.dispose?.();
            table.dispose();
        },
    };
}

/* ── kind: item — one backlog record ─────────────────────────────── */

/** Lifecycle actions per stage. Index === stage (0..4); `dropped` (stage -1)
 *  is handled separately below because it is not on the ladder. */
const STAGE_ACTIONS = [
    [['Mark refined', 'refined'], ['Drop', 'dropped']],                   // draft
    [['Start work', 'in-progress'], ['Back to draft', 'draft']],          // refined
    [['Send to review', 'review'], ['Back to refined', 'refined']],       // in-progress
    [['Mark done', 'done'], ['Back to in progress', 'in-progress']],      // review
    [['Reopen', 'in-progress']],                                          // done
];
const DROPPED_ACTIONS = [['Restore to draft', 'draft']];

/** The one transition that has a precondition: you cannot call something
 *  refined that does not meet the definition. Every other move is judgement. */
const GATED = { refined: true };

function mountItem(host, props, ctx) {
    const id = Number(String(props?.id ?? '').replace(/^#/, ''));
    if (!id) {
        host.innerHTML = `<div class="tile-placeholder"><div class="tile-placeholder__title">No item</div>
            <div class="tile-placeholder__hint">no backlog item matched ${esc(String(props?.id ?? ''))}</div></div>`;
        return { title: 'Item' };
    }

    let item = null;                     // the authoritative record, refreshed on every write
    let dirty = false;

    host.innerHTML = `
    <div class="td-page td-ticket">
        <div class="bd-ancestors" data-slot="ancestors"></div>
        <div class="td-stagebar">
            <ol class="td-stages" data-slot="stages"></ol>
        </div>
        <div class="td-stageactions">
            <span class="td-stageactions__title">${icon('bolt')} Actions</span>
            <span data-slot="stageactions"></span>
        </div>
        <div class="td-mask">
            <section class="td-group">
                <div class="td-group__title">Backlog Item</div>
                <div class="td-group__body td-grid2" data-slot="record"></div>
            </section>
            <section class="td-group">
                <div class="td-group__title">Refinement</div>
                <div class="td-group__body" data-slot="refinement"></div>
            </section>
            <section class="td-group bd-acceptance">
                <div class="td-group__title">Acceptance criteria</div>
                <div class="td-group__body" data-slot="acceptance"></div>
            </section>
            <section class="td-group" data-slot="childrenbox" hidden>
                <div class="td-group__title">Children
                    <span class="td-group__actions">
                        <button class="ea-btn ea-btn--small" data-a="addchild">${icon('add')} Add</button>
                    </span>
                </div>
                <div class="td-group__body bd-children" data-slot="children"></div>
            </section>
            <section class="td-group">
                <div class="td-group__title">Description</div>
                <div class="td-group__body td-md" data-slot="desc"><span class="td-dim">Loading…</span></div>
            </section>
            <section class="td-group">
                <div class="td-group__title">Comments <span class="td-dim">— posted as ${esc(HUMAN_AUTHOR)}</span></div>
                <div class="td-group__body" data-slot="comments"></div>
            </section>
        </div>
    </div>`;

    const actionsEl = ctx?.pageActions || null;
    if (actionsEl) {
        actionsEl.innerHTML = `
            <div class="td-floatactions">
                <button class="ea-btn" data-a="cancel" disabled>${icon('undo')} Cancel</button>
                <button class="ea-btn ea-btn--primary" data-a="save" disabled>${icon('save')} Save</button>
            </div>`;
    }

    const $ = (s) => host.querySelector(s) || actionsEl?.querySelector(s) || null;
    const fval = (k) => host.querySelector(`[data-f="${k}"]`)?.value?.trim() ?? '';
    const setDirty = (on) => {
        dirty = on;
        const save = $('[data-a="save"]'), cancel = $('[data-a="cancel"]');
        if (save) save.disabled = !on;
        if (cancel) cancel.disabled = !on;
    };

    let tagInput = null;
    let composer = null;
    let acceptanceEditor = null;
    const destroyWidgets = () => {
        for (const w of [tagInput, composer, acceptanceEditor]) {
            try { w?.destroy(); } catch { /* already gone */ }
        }
        tagInput = composer = acceptanceEditor = null;
    };

    /* ── record ─────────────────────────────────────────────────── */

    const renderRecord = () => {
        const parents = parentOptions(item.type);
        const field = (label, ctrl, span) =>
            `<div class="td-field${span ? ' td-span2' : ''}"><label>${label}</label>${ctrl}</div>`;
        const sel = (k, opts, cur) => `<select class="ea-tin" data-f="${k}">
            ${opts.map((o) => {
                const v = typeof o === 'object' ? o.value : o;
                const l = typeof o === 'object' ? o.label : o;
                return `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`;
            }).join('')}</select>`;
        const tin = (k, v) => `<input class="ea-tin" data-f="${k}" value="${esc(v ?? '')}">`;

        $('[data-slot="record"]').innerHTML = `
            ${field('Reference', `<input class="ea-tin td-mono" value="${esc(itemRef(item))}" readonly>`)}
            ${field('Status', `<input class="ea-tin td-mono" data-f="status" value="${esc(humanizeItemStatus(item.status))}" readonly>`)}
            <div class="td-field td-span2"><label class="td-req">Title</label>${tin('title', item.title)}</div>
            ${field('Type', sel('type', TYPES.map((t) => ({ value: t, label: typeLabelOf(t) })), item.type))}
            ${field('Estimate', tin('points', item.points))}
            ${item.type === 'epic'
                ? field('Phase', tin('phase', item.phase))
                : field('Parent', sel('parent', [{ value: '', label: '(none)' }, ...parents], item.parent || ''))}
            ${field('Assignee', sel('assignee', ['', HUMAN_AUTHOR, AGENT_AUTHOR], item.assignee))}
            ${field('Subsystem', tin('subsystem', item.subsystem))}
            ${item.type !== 'epic'
                ? field('Phase', `<input class="ea-tin" value="${esc(item.effectivePhase || '—')}" readonly title="Inherited from the owning epic">`)
                : ''}
            <div class="td-field td-span2"><label>Labels</label>${tin('labels', (item.labels || []).join(', '))}</div>
            ${field('Created', `<input class="ea-tin td-mono" value="${esc(item.created || '—')}" readonly>`)}
            ${field('Updated', `<input class="ea-tin td-mono" value="${esc(item.updated || '—')}" readonly>`)}`;

        try { tagInput?.destroy(); } catch { /* first render */ }
        const labelsEl = host.querySelector('[data-f="labels"]');
        tagInput = labelsEl
            ? attachTagInput(labelsEl, {
                suggestions: Array.from(new Set(ITEMS.flatMap((i) => i.labels || []))).sort(),
            })
            : null;
    };

    const renderAncestors = () => {
        const chain = Array.isArray(item.ancestors) ? item.ancestors : [];
        const el = $('[data-slot="ancestors"]');
        el.innerHTML = chain.length
            ? chain.map((a) =>
                `<button type="button" class="bd-item__ref" data-goto="${a.id}">${esc(itemRef(a))}</button>
                 <span>${esc(a.title)}</span><span class="bd-ancestors__sep">›</span>`).join('')
              + `<span>${esc(item.title)}</span>`
            : `<span class="td-dim">${item.type === 'epic' ? 'Top-level epic' : 'Not placed under a parent yet'}</span>`;
    };

    /* ── lifecycle ──────────────────────────────────────────────── */

    const renderStages = () => {
        const stage = stageOf(item.status);
        $('[data-slot="stages"]').innerHTML = LADDER.map((s, i) =>
            `<li class="td-stage ${i < stage ? 'td-stage--done' : ''} ${i === stage ? 'td-stage--active' : ''}"
                 data-stage="${i}"><span class="td-stage__num">${i + 1}</span> ${esc(humanizeItemStatus(s))}</li>`).join('');

        const actions = stage < 0 ? DROPPED_ACTIONS : STAGE_ACTIONS[stage];
        const gaps = refinementGaps(item);
        $('[data-slot="stageactions"]').innerHTML = actions.map(([label, target], i) => {
            const blocked = GATED[target] && gaps.length > 0;
            return `<button class="ea-btn td-stageaction ${i === 0 && !blocked ? 'ea-btn--primary td-stageaction--primary' : ''}"
                        data-wf="${esc(target)}" ${blocked ? 'disabled' : ''}
                        title="${blocked ? esc(`${gaps.length} thing${gaps.length === 1 ? '' : 's'} still missing — see Refinement`) : ''}">${esc(label)}</button>`;
        }).join('');
    };

    /* ── refinement checklist ───────────────────────────────────── */

    const renderRefinement = () => {
        // Read the rules rather than restating them: the skill and this panel
        // must agree on what "refined" means, and a second copy of the list is
        // how they stop agreeing.
        const gapKeys = new Set(refinementGaps(item).map((g) => g.key));
        const met = [], missing = [];
        for (const rule of REFINEMENT_RULES) {
            (gapKeys.has(rule.key) ? missing : met).push(rule.label);
        }

        $('[data-slot="refinement"]').innerHTML = missing.length
            ? `<div class="td-dim" style="margin-bottom:6px">Not refined yet — ${missing.length} of ${missing.length + met.length} checks outstanding.</div>
               <ul class="bd-gaps">${missing.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
               ${met.length ? `<ul class="bd-gaps bd-gaps--met">${met.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}`
            : `<ul class="bd-gaps bd-gaps--met">${met.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
    };

    /* ── acceptance criteria ────────────────────────────────────── */

    const renderAcceptance = () => {
        const el = $('[data-slot="acceptance"]');
        try { acceptanceEditor?.destroy(); } catch { /* first render */ }
        acceptanceEditor = null;
        el.innerHTML = `
            <textarea class="ea-tin td-area" data-f="acceptance"
                placeholder="- [ ] one checkable outcome per line"></textarea>
            <div class="bd-acceptance__foot">
                <button class="ea-btn" data-a="save-acceptance">${icon('save')} Save criteria</button>
                <span class="td-dim">${criteriaCell(
                    (item.criteria || []).filter((c) => c.done).length, (item.criteria || []).length)}</span>
            </div>`;
        const ta = el.querySelector('textarea');
        // A placeholder body means "nothing authored yet" — showing the literal
        // "_(not refined yet)_" in an editor invites saving it back as content.
        ta.value = /^_\(.*\)_$/.test((item.acceptance || '').trim()) ? '' : (item.acceptance || '');
        acceptanceEditor = attachMarkdownEditor(ta, { onStatus: statusLine, minHeight: 130 });
    };

    /* ── children ───────────────────────────────────────────────── */

    const renderChildren = () => {
        const box = $('[data-slot="childrenbox"]');
        const kids = Array.isArray(item.childItems) ? item.childItems : [];
        box.hidden = item.type === 'task' && kids.length === 0;
        $('[data-slot="children"]').innerHTML = kids.length
            ? kids.map((c) => `
                <div class="bd-childrow">
                    ${typeGlyph(c.type)}
                    <button type="button" class="bd-item__ref" data-goto="${c.id}">${esc(itemRef(c))}</button>
                    <span class="bd-childrow__title">${esc(c.title)}</span>
                    <span class="td-dim">${esc(c.points || '')}</span>
                    ${statusPill(c.status)}
                </div>`).join('')
            : '<div class="td-dim">No children yet.</div>';
    };

    /* ── description + comments ─────────────────────────────────── */

    const renderDesc = () => {
        $('[data-slot="desc"]').innerHTML = md(item.description) || '<span class="td-dim">No description.</span>';
    };

    const commentHTML = (c) => `
        <div class="td-wentry td-wentry--${c.author === HUMAN_AUTHOR ? 'human' : 'agent'}">
            <span class="td-avatar">${esc(initials(c.author))}</span>
            <div>
                <div class="td-wentry__head">
                    <b>${esc(c.author)}</b>
                    <span class="td-chip td-chip--${c.author === HUMAN_AUTHOR ? 'internal' : 'public'}">${esc(c.author)}</span>
                    <span class="td-dim td-mono">${esc(c.date)}</span>
                </div>
                <div class="td-wentry__text td-md">${md(c.body)}</div>
            </div>
        </div>`;

    const renderComments = () => {
        const el = $('[data-slot="comments"]');
        try { composer?.destroy(); } catch { /* previous mount already gone */ }
        composer = null;
        // Newest first, composer at the top — the reply you just wrote appears
        // where you are looking. Same reasoning as the bug mask.
        const comments = (item.comments || []).slice().reverse();
        el.innerHTML = `
            <div class="td-composer">
                <span class="td-avatar">${esc(initials(HUMAN_AUTHOR))}</span>
                <div class="td-composer__box">
                    <textarea class="ea-tin td-area" rows="2"
                        placeholder="Add a comment as ${esc(HUMAN_AUTHOR)}… (Enter posts, Alt+Enter for a new line)"></textarea>
                </div>
            </div>
            <div class="td-wstream">${comments.length ? comments.map(commentHTML).join('') : '<div class="td-dim">No comments yet.</div>'}</div>`;

        composer = attachMarkdownEditor(el.querySelector('textarea'), {
            submitLabel: 'Comment',
            onStatus: statusLine,
            onSubmit: async (text) => {
                if (!text) { statusLine('Nothing to post.'); return; }
                try {
                    apply(await postItemComment(item.id, text, HUMAN_AUTHOR));
                    statusLine('Comment added.');
                } catch (err) { statusLine(`Comment failed: ${err?.message || err}`); }
            },
        });
    };

    /* ── the write path ─────────────────────────────────────────── */

    /** One place where a fresh record becomes the rendered page, so no caller
     *  has to remember which six sections a write invalidates. */
    const apply = (fresh) => {
        item = fresh;
        renderAncestors();
        renderRecord();
        renderStages();
        renderRefinement();
        renderAcceptance();
        renderChildren();
        renderDesc();
        renderComments();
        setDirty(false);
    };

    /** Re-read the whole backlog so the tree, the rail counts and the parent
     *  pickers agree with what was just written, then tell the other pages. */
    const broadcast = async () => {
        try { await loadBacklog(); } catch (err) { console.warn('[bugdesk] backlog reload failed', err); }
        _eventBus?.emit?.('backlog:changed', { id: item?.id });
    };

    const save = async () => {
        try {
            const patch = {
                title: fval('title'),
                type: fval('type'),
                points: fval('points'),
                assignee: fval('assignee'),
                subsystem: fval('subsystem') || 'unsorted',
                labels: fval('labels') ? fval('labels').split(',').map((s) => s.trim()).filter(Boolean) : [],
            };
            if (item.type === 'epic') patch.phase = fval('phase');
            else patch.parent = Number(fval('parent') || 0);
            apply(await patchItem(item.id, patch));
            await broadcast();
            statusLine(`${itemRef(item)} saved.`);
        } catch (err) { statusLine(`Save failed: ${err?.message || err}`); }
    };

    const cancel = async () => {
        try { apply(await fetchItem(id)); statusLine('Reverted unsaved changes.'); }
        catch (err) { statusLine(`Revert failed: ${err?.message || err}`); }
    };

    const saveAcceptance = async () => {
        try {
            apply(await patchItem(item.id, { acceptance: host.querySelector('[data-f="acceptance"]')?.value || '' }));
            await broadcast();
            statusLine('Acceptance criteria saved.');
        } catch (err) { statusLine(`Save failed: ${err?.message || err}`); }
    };

    const moveTo = async (status) => {
        try {
            apply(await patchItem(item.id, { status }));
            await broadcast();
            statusLine(`${itemRef(item)} → ${humanizeItemStatus(item.status)}.`);
        } catch (err) { statusLine(`Transition failed: ${err?.message || err}`); }
    };

    /* ── wiring ─────────────────────────────────────────────────── */

    host.addEventListener('input', (e) => { if (e.target.matches('[data-f]:not([readonly])')) setDirty(true); });
    host.addEventListener('change', (e) => { if (e.target.matches('[data-f]:not([readonly])')) setDirty(true); });

    const onClick = async (e) => {
        const goto = e.target.closest('[data-goto]');
        if (goto) {
            const target = ITEMS.find((x) => Number(x.id) === Number(goto.dataset.goto));
            ctx.wm?.openInTabFromContext?.(ctx, 'item',
                { id: goto.dataset.goto, label: itemLabel(target) || `#${goto.dataset.goto}` });
            return;
        }
        const wf = e.target.closest('[data-wf]');
        if (wf && !wf.disabled) { await moveTo(wf.dataset.wf); return; }

        const act = e.target.closest('[data-a]')?.dataset.a;
        if (act === 'save') await save();
        else if (act === 'cancel') await cancel();
        else if (act === 'save-acceptance') await saveAcceptance();
        else if (act === 'addchild') {
            const created = await openCreateForm({
                type: item.type === 'epic' ? 'story' : 'task',
                parent: item.id,
            });
            if (created) { apply(await fetchItem(item.id)); await broadcast(); }
        }
    };
    host.addEventListener('click', onClick);
    actionsEl?.addEventListener('click', onClick);

    (async () => {
        try {
            apply(await fetchItem(id));
        } catch (err) {
            host.querySelector('.td-mask').innerHTML =
                `<div class="td-dim">Failed to load item ${esc(String(id))}: ${esc(err?.message || String(err))}</div>`;
        }
    })();

    return {
        title: itemLabel(ITEMS.find((x) => Number(x.id) === id)) || `Item ${id}`,
        destroy: destroyWidgets,
    };
}

/* ── the Backlog half of the left rail ───────────────────────────── */

/**
 * Views, then phases. Exported for pages.js's `mountTicketNav`, which owns the
 * panel and the Bugs/Backlog tab strip — a panel kind can only be registered
 * once, so the two rails are one mount with two bodies rather than two kinds
 * fighting over `panel:left`.
 *
 * @returns {{ render: () => void, destroy: () => void }}
 */
export function mountBacklogRail(host, ctx) {
    const open = (p) => ctx.wm?.openInPrimary?.('backlog', p);

    const countFor = (view) => ITEMS.filter(view.match).length;

    const render = () => {
        host.innerHTML = `
        <div class="td-nav">
            <div class="td-nav__section">Views</div>
            ${BACKLOG_VIEWS.map((v) => {
                const resolved = resolveView(v.key, '');
                return `
                <div class="td-nav__item" data-view="${esc(v.key)}" role="button" tabindex="0"
                     title="${esc(v.label)}">
                    ${icon(esc(v.icon))}
                    <span>${esc(v.label)}</span>
                    <span class="td-nav__badge">${countFor(resolved)}</span>
                </div>`;
            }).join('')}
            <div class="td-nav__section">Phases</div>
            ${PHASES.length
                ? PHASES.map((p) => `
                    <div class="td-nav__item" data-phase="${esc(p)}" role="button" tabindex="0"
                         title="Everything in phase ${esc(p)}">
                        ${icon('flag')}<span>${esc(p)}</span>
                        <span class="td-nav__badge">${ITEMS.filter((i) => i.phaseLabel === p).length}</span>
                    </div>`).join('')
                : '<div class="td-nav__item"><span class="td-dim">No phases yet — set one on an epic</span></div>'}
            <div class="td-nav__item" data-new="epic" role="button" tabindex="0">
                ${icon('add')}<span class="td-dim">New epic</span>
            </div>
        </div>`;
    };
    render();

    const activate = async (el) => {
        if (el.dataset.view) { open({ view: el.dataset.view }); return; }
        if (el.dataset.phase) { open({ view: 'board', phase: el.dataset.phase }); return; }
        if (el.dataset.new) {
            const created = await openCreateForm({ type: el.dataset.new });
            if (created) { render(); open({ view: DEFAULT_VIEW }); }
        }
    };

    const onClick = (e) => {
        const row = e.target.closest('[data-view],[data-phase],[data-new]');
        if (row) activate(row);
    };
    const onKey = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('[data-view],[data-phase],[data-new]');
        if (!row) return;
        e.preventDefault();
        activate(row);
    };
    host.addEventListener('click', onClick);
    host.addEventListener('keydown', onKey);

    const sub = _eventBus?.on?.('backlog:changed', () => render());

    return {
        render,
        destroy: () => {
            sub?.dispose?.();
            host.removeEventListener('click', onClick);
            host.removeEventListener('keydown', onKey);
        },
    };
}

/* ── content map ─────────────────────────────────────────────────── */

let _eventBus = null;

/**
 * Build the backlog's `{ kind: factory }` map. Merged by install.js alongside
 * ticketdesk's — the two own disjoint kinds, so order between them does not
 * matter (unlike the page stubs, which these deliberately shadow).
 */
export function createBacklogContent({ eventBus } = {}) {
    _eventBus = eventBus || null;
    return {
        backlog: shell('backlog', mountBacklogBoard),
        item: shell('item', mountItem),
    };
}

export { openCreateForm as openBacklogCreate };
