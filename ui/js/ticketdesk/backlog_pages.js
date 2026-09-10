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
import { showContextMenu } from '../ecoagent/ui/context_menu.js';
import { renderMarkdown } from './markdown.js';
import { attachMarkdownEditor } from './md_editor.js';
import { attachTagInput } from './tag_input.js';
import { openFilterEditor } from './filter_editor.js';
import { openNewItem } from './new_item.js';
import { onFiltersChanged } from './filter_store.js';
import { shell, statusLine } from './pages.js';
import { esc, initials, HUMAN_AUTHOR, AGENT_AUTHOR, assigneeOptions } from './data.js';
import {
    BUILTIN_FILTERS, DEFAULT_FILTER, MODEL, SCOPE,
    adhocFilter, deleteFilter, describeFilter, duplicateFilter, epicExpr,
    getFilter, listFilters, matcherFor, resolveFilter,
} from './backlog_filters.js';
import {
    ITEMS, PHASES, TYPES, TYPE_ICON,
    collapsibleIds, fetchItem, humanizeItemStatus, isGated, parentOptions,
    itemLabel, itemRef, ladderFor, loadBacklog, patchItem, postItemComment,
    REFINEMENT_RULES, refinementGaps, stageActions, stageOf, treeRows,
    typeLabelOf,
} from './backlog_data.js';

/** Set by createBacklogContent at registration, before any mount runs. */
let _eventBus = null;

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

/* ── collapse state ──────────────────────────────────────────────────
 *
 * Which subtrees are folded is a per-person preference about a shared store, so
 * it lives in the user's profile (`GET`/`POST /api/user/settings`) rather than
 * localStorage: BugDesk is a tool you run from wherever the repo is checked
 * out, and a fold that does not survive moving machines is a fold you re-do
 * every morning.
 *
 * Reads are served from an in-memory cache so a render never awaits; the write
 * is fire-and-forget for the same reason. A failed write costs a fold, which is
 * not worth blocking a click over — but it is still reported, not swallowed.
 */
const COLLAPSE_KEY = 'backlog.collapsed';
let _collapsed = new Set();
let _collapseLoaded = false;

async function loadCollapsed() {
    if (_collapseLoaded) return _collapsed;
    _collapseLoaded = true;
    try {
        const res = await fetch('/api/user/settings', { headers: { accept: 'application/json' } });
        const j = res.ok ? await res.json() : null;
        const ids = j?.settings?.[COLLAPSE_KEY];
        if (Array.isArray(ids)) _collapsed = new Set(ids.map(Number).filter(Boolean));
    } catch (err) {
        console.warn('[bugdesk] could not read collapse state', err);
    }
    return _collapsed;
}

function saveCollapsed() {
    fetch('/api/user/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ [COLLAPSE_KEY]: Array.from(_collapsed) }),
    }).catch((err) => statusLine(`Could not save the fold state: ${err?.message || err}`));
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

/**
 * The tree drawing for one row's Title cell: guide lines for every ancestor
 * level, then this row's own connector, then a caret if it has children.
 *
 * Guides are spans rather than box-drawing characters so they line up at any
 * font — `└─` in a proportional fallback font is ragged, and this column is
 * where the hierarchy is supposed to be legible at a glance.
 */
function treeGuides(row) {
    if (!row.depth) return '';
    const parts = [];
    // One rail per ancestor level. `ancestorsLast[k]` true means that ancestor
    // was the last of its siblings, so its vertical line has already ended.
    for (let k = 0; k < row.depth - 1; k++) {
        parts.push(`<span class="bd-guide ${row.ancestorsLast[k + 1] ? '' : 'bd-guide--line'}"></span>`);
    }
    parts.push(`<span class="bd-guide bd-guide--${row.isLast ? 'end' : 'tee'}"></span>`);
    return parts.join('');
}

function mountBacklogBoard(host, props, ctx) {
    // props.expr (ad-hoc, e.g. a rail epic click) beats props.filter (a stored
    // key or saved id) — same precedence as the bug queue.
    let view = props?.expr
        ? adhocFilter(props.expr, props.label)
        : resolveFilter(props?.filter);

    host.innerHTML = `
    <div class="td-page">
        <div class="td-page__bar">
            <span class="td-page__title" data-slot="title">${icon(esc(view.icon))} ${esc(view.label)}</span>
            <span class="td-dim" data-slot="count"></span>
            <span class="td-spacer"></span>
            <button class="ea-btn" data-a="expand" title="Expand every item">${icon('unfold_more')}</button>
            <button class="ea-btn" data-a="collapse" title="Collapse every item">${icon('unfold_less')}</button>
            <button class="ea-btn" data-a="savefilter">${icon('filter_alt')} Save as filter</button>
            <span class="bd-newgroup">
                <span class="td-dim">New</span>
                <button class="ea-btn" data-a="new-epic" title="New epic">${icon('workspaces')} Epic</button>
                <button class="ea-btn" data-a="new-story" title="New story">${icon('article')} Story</button>
                <button class="ea-btn" data-a="new-task" title="New task">${icon('check_box_outline_blank')} Task</button>
            </span>
        </div>
        <div class="td-tablehost"></div>
    </div>`;

    const openBoard = (p) => {
        if (ctx.wm?.navigate) ctx.wm.navigate('backlog', p, { ctx, dest: 'origin' });
        else ctx.wm?.openInPrimary?.('backlog', p);
    };
    const openItem = (id, opts) => {
        const model = ITEMS.find((x) => Number(x.id) === Number(id));
        const p = { id: String(id), label: itemLabel(model) || `#${id}`, filter: view.key || DEFAULT_FILTER };
        if (ctx.wm?.navigate) ctx.wm.navigate('item', p, { ctx, ...opts });
        else ctx.wm?.openInTabFromContext?.(ctx, 'item', p);
    };
    const openSavedFilter = (f) => openBoard({ filter: f.id, label: f.label });

    /** Row models keyed by their reference, so a SORTED table can still find
     *  the item behind a row — the row index after a sort is not the store
     *  index. Rebuilt on every rows() call. */
    let byRef = new Map();

    const rows = () => {
        const list = treeRows(view.match, _collapsed);
        byRef = new Map(list.map((i) => [i.ref, i]));
        const matched = list.filter((i) => !i.context).length;
        const context = list.length - matched;
        const countEl = host.querySelector('[data-slot="count"]');
        if (countEl) {
            countEl.textContent = context
                ? `${matched} item${matched === 1 ? '' : 's'} · ${context} shown for context`
                : `${matched} item${matched === 1 ? '' : 's'}`;
        }
        return list.map(boardRow);
    };

    const refresh = () => table.setData({ rows: rows() });

    const toggleFold = (id) => {
        if (_collapsed.has(id)) _collapsed.delete(id); else _collapsed.add(id);
        saveCollapsed();
        refresh();
    };

    const menuRefs = (cm) => (cm.selectedRows?.length ? cm.selectedRows : (cm.row ? [cm.row] : []))
        .map((r) => r?.[REF_COL]).filter(Boolean);

    const table = new DataTable(host.querySelector('.td-tablehost'), {
        headers: BOARD_HEADERS,
        rows: [],
        pagination: false,
        selectable: true,
        copyable: true,
        // Sorting flattens the hierarchy — a tree sorted by Updated is no longer
        // a tree — so the Item/Title columns keep their tree order and the rest
        // stay sortable for the "just find it" case.
        sortable: true,
        filterable: true,
        mode: 'compact',
        emptyMessage: 'Nothing in this view',
        services: { eventBus: _eventBus },
        contextMenuItems: (cm) => {
            const refs = menuRefs(cm);
            const model = cm.row ? byRef.get(cm.row[REF_COL]) : null;
            return [
                { label: refs.length > 1 ? `Open ${refs.length} items in tabs` : 'Open',
                  icon: 'open_in_new', action: 'open', disabled: !refs.length },
                { label: 'Open in new window', icon: 'web_asset', action: 'open-window', disabled: !model },
                { label: 'Open in split right', icon: 'splitscreen_vertical_add', action: 'open-split-h', disabled: !model },
                { separator: true },
                { label: model?.isCollapsed ? 'Expand' : 'Collapse', icon: 'account_tree',
                  action: 'fold', disabled: !model?.hasChildren },
                { label: 'Show only this work package', icon: 'filter_center_focus',
                  action: 'focus-epic', disabled: !model?.epicRef },
                { separator: true },
                // A task cannot hold children, so the entry is greyed rather
                // than hidden — the menu keeps one shape whichever row you hit.
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
                case 'fold': if (model?.hasChildren) toggleFold(Number(model.id)); break;
                case 'focus-epic':
                    if (model?.epicRef) openBoard({ expr: epicExpr(model.epicRef), label: model.epicRef });
                    break;
                case 'add-child': {
                    if (!model) break;
                    const created = await openNewItem({
                        kind: model.type === 'epic' ? 'story' : 'task',
                        parent: model.id,
                    });
                    if (created) {
                        // A new child under a folded parent would land invisible.
                        _collapsed.delete(Number(model.id));
                        refresh();
                        openItem(created.record.id, { dest: 'origin', newTab: true });
                    }
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
                // The hierarchy IS this cell: guides, a fold caret, the type
                // glyph, the title. The bridge hands rows back in tree order and
                // treeRows() works out the shape; this only draws it.
                const caret = model?.hasChildren
                    ? `<button type="button" class="bd-caret" data-fold="${model.id}"
                               aria-label="${model.isCollapsed ? 'Expand' : 'Collapse'} ${esc(model.ref)}"
                               aria-expanded="${model.isCollapsed ? 'false' : 'true'}">${icon(model.isCollapsed ? 'chevron_right' : 'expand_more')}</button>`
                    : '<span class="bd-caret bd-caret--none"></span>';
                td.innerHTML = `<span class="bd-item${model?.context ? ' bd-item--context' : ''}">
                    ${treeGuides(model || {})}${caret}${typeGlyph(model?.type || 'task')}<span class="bd-item__title">${esc(value)}</span>
                    ${model?.hidden ? `<span class="bd-item__hidden">+${model.hidden}</span>` : ''}</span>`;
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

    // The caret lives INSIDE a row, so its click would also open the item.
    // Caught in the capture phase, before DataTable's own row handler sees it.
    const onCaret = (e) => {
        const btn = e.target.closest?.('[data-fold]');
        if (!btn) return;
        e.stopPropagation();
        e.preventDefault();
        toggleFold(Number(btn.dataset.fold));
    };
    host.addEventListener('click', onCaret, true);

    // Collapse state may not have arrived yet on the very first mount; render
    // what we have, then repaint once it does.
    table.setData({ rows: rows() });
    table.render();
    loadCollapsed().then(() => { if (host.isConnected) refresh(); });
    requestAnimationFrame(() => { if (host.isConnected) table.focus(); });

    const actions = {
        expand: () => { _collapsed.clear(); saveCollapsed(); refresh(); },
        collapse: () => {
            for (const id of collapsibleIds()) _collapsed.add(id);
            saveCollapsed();
            refresh();
        },
        savefilter: () => openFilterEditor({
            model: MODEL, scope: SCOPE,
            seedExpr: view.expr, items: ITEMS,
            rowLabel: (i) => ({ id: i.ref, title: i.title, status: i.statusLabel, dot: i.type }),
            onSaved: openSavedFilter,
        }),
        'new-epic': async () => { if (await openNewItem({ kind: 'epic' })) refresh(); },
        'new-story': async () => { if (await openNewItem({ kind: 'story' })) refresh(); },
        'new-task': async () => { if (await openNewItem({ kind: 'task' })) refresh(); },
    };
    host.querySelector('.td-page__bar').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-a]');
        if (btn && actions[btn.dataset.a]) actions[btn.dataset.a]();
    });

    // A save/delete in the editor changes what this view means (or deletes it
    // outright — resolveFilter then lands on the default). Ad-hoc views own
    // their expression, so nothing in the store can move them.
    const unsub = onFiltersChanged(() => {
        if (view.adhoc) return;
        view = resolveFilter(view.key);
        const titleEl = host.querySelector('[data-slot="title"]');
        if (titleEl) titleEl.innerHTML = `${icon(esc(view.icon))} ${esc(view.label)}`;
        refresh();
    });

    // An edit made on an item page changes what this table shows. The bus event
    // is emitted by the item page after every successful write.
    //
    // NOTE the handle: EventBus.on() returns { id, dispose } and off() takes
    // THAT, not (name, handler) — a call shaped like removeEventListener finds
    // no listener id, returns false and leaves the subscription in place.
    const sub = _eventBus?.on?.('backlog:changed', () => {
        if (!view.adhoc) view = resolveFilter(view.key);
        refresh();
    });

    return {
        title: view.label,
        destroy: () => {
            unsub();
            sub?.dispose?.();
            host.removeEventListener('click', onCaret, true);
            table.dispose();
        },
    };
}

/* ── kind: item — one backlog record ─────────────────────────────── */

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
            ${field('Assignee', sel('assignee', assigneeOptions(), item.assignee))}
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

    // The chevrons and the buttons are BOTH derived from this item's own ladder
    // (an epic has no `review`, a task no `refined`), so a type change repaints
    // a different lifecycle rather than offering transitions the server rejects.
    const renderStages = () => {
        const ladder = item.ladder?.length ? item.ladder : ladderFor(item.type);
        const stage = stageOf(item);
        const dropped = item.status === 'dropped';

        $('[data-slot="stages"]').innerHTML = ladder.map((s, i) =>
            `<li class="td-stage ${!dropped && i < stage ? 'td-stage--done' : ''} ${i === stage ? 'td-stage--active' : ''}"
                 data-stage="${i}"><span class="td-stage__num">${i + 1}</span> ${esc(humanizeItemStatus(s))}</li>`).join('')
            + (dropped ? `<li class="td-stage td-stage--active bd-stage--dropped">${esc(humanizeItemStatus('dropped'))}</li>` : '');

        const gaps = refinementGaps(item);
        $('[data-slot="stageactions"]').innerHTML = stageActions(item).map(([label, target], i) => {
            const blocked = isGated(target) && gaps.length > 0;
            return `<button class="ea-btn td-stageaction ${i === 0 && !blocked ? 'ea-btn--primary td-stageaction--primary' : ''}"
                        data-wf="${esc(target)}" ${blocked ? 'disabled' : ''}
                        title="${blocked ? esc(`${gaps.length} thing${gaps.length === 1 ? '' : 's'} still missing — see Refinement`) : ''}">${esc(label)}</button>`;
        }).join('');
    };

    /* ── refinement checklist ───────────────────────────────────── */

    const renderRefinement = () => {
        // A task never passes through `refined` — it inherits its story's
        // acceptance criteria, so there is nothing about it to refine. Showing
        // it a checklist it can never need is how a lifecycle stops meaning
        // anything; point at the story instead.
        if (item.type === 'task') {
            const parent = ITEMS.find((x) => Number(x.id) === Number(item.parent));
            $('[data-slot="refinement"]').innerHTML = parent
                ? `<div class="td-dim">A task inherits its parent's acceptance criteria —
                   <button type="button" class="bd-item__ref" data-goto="${parent.id}">${esc(parent.ref)}</button>
                   ${esc(parent.title)} (${parent.criteriaDone}/${parent.criteriaTotal} met).</div>`
                : `<div class="td-dim">This task has no parent yet, so it inherits no acceptance
                   criteria. Set one above.</div>`;
            return;
        }

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

    /**
     * Acceptance criteria as a REAL checklist, not markdown you have to hand-edit.
     *
     * Each row is a checkbox you tick, and each edit is one addressed operation
     * on one line (`POST /api/backlog/{id}/criteria`) rather than a rewrite of
     * the whole section. That matters because the section is hand-authored
     * markdown that may carry a sentence of context or a nested sub-bullet —
     * regenerating it from the parsed rows would delete all of that the first
     * time anyone ticked a box.
     *
     * The markdown view is still one click away, for bulk edits and for anything
     * a checklist cannot express.
     */
    let acceptanceRaw = false;      // showing the markdown editor instead

    const criterion = (c, i) => `
        <li class="bd-crit-row${c.done ? ' bd-crit-row--done' : ''}">
            <input type="checkbox" class="bd-crit-row__box" data-crit-toggle="${i}"
                   ${c.done ? 'checked' : ''}
                   aria-label="${esc(c.text)}">
            <button type="button" class="bd-crit-row__text" data-crit-edit="${i}"
                    title="Click to edit">${esc(c.text)}</button>
            <button type="button" class="bd-crit-row__rm" data-crit-remove="${i}"
                    title="Remove" aria-label="Remove criterion">${icon('close')}</button>
        </li>`;

    const renderAcceptance = () => {
        const el = $('[data-slot="acceptance"]');
        try { acceptanceEditor?.destroy(); } catch { /* first render */ }
        acceptanceEditor = null;

        const list = item.criteria || [];
        const done = list.filter((c) => c.done).length;

        if (acceptanceRaw) {
            el.innerHTML = `
                <textarea class="ea-tin td-area" data-f="acceptance"
                    placeholder="- [ ] one checkable outcome per line"></textarea>
                <div class="bd-acceptance__foot">
                    <button class="ea-btn" data-a="save-acceptance">${icon('save')} Save</button>
                    <button class="ea-btn" data-a="acceptance-list">${icon('checklist')} Back to checklist</button>
                </div>`;
            const ta = el.querySelector('textarea');
            // A placeholder body means "nothing authored yet" — showing the
            // literal "_(not refined yet)_" invites saving it back as content.
            ta.value = /^_\(.*\)_$/.test((item.acceptance || '').trim()) ? '' : (item.acceptance || '');
            acceptanceEditor = attachMarkdownEditor(ta, { onStatus: statusLine, minHeight: 130 });
            return;
        }

        el.innerHTML = `
            ${list.length
                ? `<ul class="bd-crit-list">${list.map(criterion).join('')}</ul>`
                : `<div class="td-dim bd-crit-empty">No acceptance criteria yet${
                    item.type === 'task' ? ' — a task usually inherits its story\'s.' : '.'}</div>`}
            <div class="bd-crit-add">
                ${icon('add')}
                <input class="ea-tin bd-crit-add__input" data-crit-new
                       placeholder="Add a criterion — one checkable outcome">
            </div>
            <div class="bd-acceptance__foot">
                <span class="td-dim">${criteriaCell(done, list.length)}</span>
                <span class="td-spacer"></span>
                <button class="ea-btn ea-btn--small" data-a="acceptance-raw">${icon('edit_note')} Edit as markdown</button>
            </div>`;
    };

    /** One addressed edit, then repaint from what the bridge says it now is. */
    const criteriaOp = async (op, index, value) => {
        try {
            const res = await fetch(`/api/backlog/${item.id}/criteria`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ op, index, value }),
            });
            const j = await res.json().catch(() => null);
            if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
            apply(j.item);
            await broadcast();
        } catch (err) {
            statusLine(`Criteria update failed: ${err?.message || err}`);
            renderAcceptance();   // put the checkbox back where the file says it is
        }
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

    // Checklist interaction. Delegated, because renderAcceptance replaces the
    // whole list on every change.
    const onCriteriaChange = (e) => {
        const box = e.target.closest('[data-crit-toggle]');
        if (!box) return;
        criteriaOp('toggle', Number(box.dataset.critToggle), box.checked ? '1' : '0');
    };
    host.addEventListener('change', onCriteriaChange);

    /** Turn a criterion into an input in place. Enter or blur commits; Escape
     *  restores. Editing text is rare next to ticking, so it stays out of the
     *  way until asked for rather than living as a permanent input. */
    const editCriterion = (btn, index) => {
        const input = document.createElement('input');
        input.className = 'ea-tin bd-crit-row__edit';
        input.value = btn.textContent.trim();
        let settled = false;
        const commit = (save) => {
            if (settled) return;
            settled = true;
            const text = input.value.trim();
            if (save && text && text !== btn.textContent.trim()) criteriaOp('edit', index, text);
            else renderAcceptance();
        };
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
            else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
        });
        input.addEventListener('blur', () => commit(true));
        btn.replaceWith(input);
        input.focus();
        input.select();
    };

    const onCriteriaKey = (e) => {
        const add = e.target.closest('[data-crit-new]');
        if (!add || e.key !== 'Enter') return;
        e.preventDefault();
        const text = add.value.trim();
        if (!text) return;
        add.value = '';
        criteriaOp('add', -1, text);
    };
    host.addEventListener('keydown', onCriteriaKey);

    const onClick = async (e) => {
        const critEdit = e.target.closest('[data-crit-edit]');
        if (critEdit) { editCriterion(critEdit, Number(critEdit.dataset.critEdit)); return; }
        const critRm = e.target.closest('[data-crit-remove]');
        if (critRm) { await criteriaOp('remove', Number(critRm.dataset.critRemove), ''); return; }

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
        else if (act === 'save-acceptance') { await saveAcceptance(); acceptanceRaw = false; renderAcceptance(); }
        else if (act === 'acceptance-raw') { acceptanceRaw = true; renderAcceptance(); }
        else if (act === 'acceptance-list') { acceptanceRaw = false; renderAcceptance(); }
        else if (act === 'addchild') {
            const created = await openNewItem({
                kind: item.type === 'epic' ? 'story' : 'task',
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
        destroy: () => {
            host.removeEventListener('change', onCriteriaChange);
            host.removeEventListener('keydown', onCriteriaKey);
            destroyWidgets();
        },
    };
}

/* ── the Backlog half of the left rail ───────────────────────────────
 *
 * Three sections:
 *   "Views"       BUILTIN_FILTERS, in store order (that IS the rail order)
 *   "My filters"  the user's own backlog filters, with the same
 *                 Open/Edit/Duplicate/Delete set the bug rail has
 *   "Work packages"  phases → their epics, as a navigable tree
 *
 * The third one is the point. A flat list of views tells you what STATE things
 * are in; the backlog's actual shape is phase → epic → story → task, and the
 * rail is where you navigate that shape rather than scroll it. Clicking an epic
 * opens the board scoped to that whole work package — an ad-hoc `epic is
 * EPIC-0001` expression, which is the same thing "Show only this work package"
 * does from the tree's context menu.
 *
 * Exported for pages.js's `mountTicketNav`, which owns the panel and the
 * Bugs/Backlog tab strip — a panel kind can only be registered once, so the two
 * rails are one mount with two bodies rather than two kinds fighting over
 * `panel:left`.
 */

/** One action button, shared by the click handler and the context menu. */
const navAction = (act, glyph, label, danger = false) =>
    `<button type="button" class="td-nav__action${danger ? ' td-nav__action--danger' : ''}"
             data-act="${act}" title="${esc(label)}" aria-label="${esc(label)}">${icon(glyph)}</button>`;

/**
 * @returns {{ render: () => void, destroy: () => void }}
 */
export function mountBacklogRail(host, ctx) {
    const open = (p) => ctx.wm?.openInPrimary?.('backlog', p);
    const openFilter = (f) => open({ filter: f.key || f.id, label: f.label });
    const countFor = (expr) => ITEMS.filter(matcherFor(expr)).length;

    /** Epics grouped by their phase, plus a bucket for the unassigned ones.
     *  Phases come from the store's live vocabulary, so a phase whose epics are
     *  all done still lists — you navigate to finished work too. */
    const workPackages = () => {
        const epics = ITEMS.filter((i) => i.type === 'epic');
        const groups = new Map(PHASES.map((p) => [p, []]));
        const loose = [];
        for (const e of epics) {
            const phase = e.phaseLabel || '';
            if (!phase) { loose.push(e); continue; }
            if (!groups.has(phase)) groups.set(phase, []);
            groups.get(phase).push(e);
        }
        const out = Array.from(groups.entries()).map(([phase, list]) => ({ phase, epics: list }));
        if (loose.length) out.push({ phase: '', epics: loose });
        return out;
    };

    /** Items in an epic's whole subtree — the number the epic row shows, since
     *  "5" next to a work package means five things in it, not five children. */
    const subtreeCount = (ref) => ITEMS.filter((i) => i.epicRef === ref).length;

    const filterRow = (f, custom) => {
        const key = custom ? f.id : f.key;
        return `
        <div class="td-nav__item${custom ? ' td-nav__item--custom' : ''}" data-filter="${esc(key)}"
             data-custom="${custom ? '1' : ''}" role="button" tabindex="0"
             title="${esc(describeFilter(f.expr))}">
            ${icon(esc(f.icon || 'filter_alt'))}
            <span>${esc(f.label)}</span>
            <span class="td-nav__actions">
                ${custom ? navAction('edit', 'edit', `Edit filter ${f.label}`) : ''}
                ${navAction('duplicate', 'content_copy', custom ? `Duplicate filter ${f.label}` : `Duplicate ${f.label} as a filter of your own`)}
                ${navAction('copydef', 'notes', `Copy the definition of ${f.label}`)}
                ${custom ? navAction('delete', 'delete', `Delete filter ${f.label}`, true) : ''}
            </span>
            <span class="td-nav__badge">${countFor(f.expr)}</span>
        </div>`;
    };

    const render = () => {
        const custom = listFilters();
        const packages = workPackages();
        host.innerHTML = `
        <div class="td-nav">
            <div class="td-nav__section">Views</div>
            ${BUILTIN_FILTERS.map((f) => filterRow(f, false)).join('')}

            <div class="td-nav__section">My filters</div>
            ${custom.length
                ? custom.map((f) => filterRow(f, true)).join('')
                : '<div class="td-nav__item"><span class="td-dim">No backlog filters yet</span></div>'}
            <div class="td-nav__item" data-new="1" role="button" tabindex="0">
                ${icon('add')}<span class="td-dim">New filter</span>
            </div>

            <div class="td-nav__section">Work packages</div>
            ${packages.length
                ? packages.map((g) => `
                    <div class="td-nav__item td-nav__item--phase" data-phase="${esc(g.phase)}"
                         role="button" tabindex="0"
                         title="${g.phase ? `Everything in phase ${esc(g.phase)}` : 'Epics with no phase set'}">
                        ${icon(g.phase ? 'flag' : 'flag_circle')}
                        <span>${esc(g.phase || 'No phase')}</span>
                        <span class="td-nav__badge">${g.epics.length}</span>
                    </div>
                    ${g.epics.map((e) => `
                        <div class="td-nav__item td-nav__item--epic" data-epic="${esc(e.ref)}"
                             role="button" tabindex="0" title="${esc(e.title)}">
                            ${typeGlyph('epic')}
                            <span>${esc(e.title)}</span>
                            <span class="td-nav__badge">${subtreeCount(e.ref)}</span>
                        </div>`).join('')}`).join('')
                : '<div class="td-nav__item"><span class="td-dim">No epics yet</span></div>'}
        </div>`;
    };
    render();

    const newFilter = () => openFilterEditor({
        model: MODEL, scope: SCOPE, items: ITEMS,
        rowLabel: (i) => ({ id: i.ref, title: i.title, status: i.statusLabel, dot: i.type }),
        onSaved: openFilter,
    });

    /** The one command table behind both the buttons and the context menu. */
    const runAction = (act, key, custom) => {
        const f = getFilter(key);
        if (!f) { statusLine(`Filter "${key}" no longer exists.`); return; }
        switch (act) {
            case 'open': openFilter(f); break;
            case 'edit':
                // Builtins have no editor path — they are duplicated instead.
                if (custom) openFilterEditor({
                    model: MODEL, scope: SCOPE, filter: f, items: ITEMS,
                    rowLabel: (i) => ({ id: i.ref, title: i.title, status: i.statusLabel, dot: i.type }),
                    onSaved: openFilter,
                });
                break;
            case 'duplicate': {
                const draft = duplicateFilter(key);  // id-less draft → editor opens as "New filter"
                if (draft) openFilterEditor({
                    model: MODEL, scope: SCOPE, filter: draft, items: ITEMS,
                    rowLabel: (i) => ({ id: i.ref, title: i.title, status: i.statusLabel, dot: i.type }),
                    onSaved: openFilter,
                });
                break;
            }
            case 'copydef': {
                const text = describeFilter(f.expr);
                navigator.clipboard.writeText(text)
                    .then(() => statusLine(`Copied filter definition: ${text}`))
                    .catch((err) => statusLine(`Copy failed: ${err?.message || err}`));
                break;
            }
            case 'delete':
                if (custom && window.confirm(`Delete filter "${f.label}"?`)) deleteFilter(f.id);
                break;
        }
    };

    const activate = (el, target) => {
        if (el.dataset.epic) { open({ expr: epicExpr(el.dataset.epic), label: el.dataset.epic }); return; }
        if (el.dataset.phase !== undefined && el.classList.contains('td-nav__item--phase')) {
            const phase = el.dataset.phase;
            open(phase
                ? { expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'phase', op: 'is', value: phase }] }, label: phase }
                : { expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'phase', op: 'is_empty' }] }, label: 'No phase' });
            return;
        }
        if (el.dataset.new) { newFilter(); return; }
        if (el.dataset.filter) {
            const btn = target?.closest?.('.td-nav__action');
            runAction(btn ? btn.dataset.act : 'open', el.dataset.filter, !!el.dataset.custom);
        }
    };

    const onClick = (e) => {
        const row = e.target.closest('[data-filter],[data-epic],[data-phase],[data-new]');
        if (row) activate(row, e.target);
    };
    const onKey = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target.closest('.td-nav__action')) return;   // native button, already handled
        const row = e.target.closest('[data-filter],[data-epic],[data-phase],[data-new]');
        if (!row) return;
        e.preventDefault();
        activate(row, null);
    };
    const onContextMenu = (e) => {
        const row = e.target.closest('[data-filter]');
        if (!row) return;
        e.preventDefault();
        const custom = !!row.dataset.custom;
        showContextMenu(e.clientX, e.clientY, custom
            ? [
                { label: 'Open', icon: 'open_in_new', action: 'open' },
                { label: 'Edit filter…', icon: 'edit', action: 'edit' },
                { label: 'Duplicate', icon: 'content_copy', action: 'duplicate' },
                { label: 'Copy definition', icon: 'notes', action: 'copydef' },
                { separator: true },
                { label: 'Delete filter', icon: 'delete', action: 'delete', danger: true },
            ]
            : [
                { label: 'Open', icon: 'open_in_new', action: 'open' },
                { label: 'Duplicate as a filter of your own', icon: 'content_copy', action: 'duplicate' },
                { label: 'Copy definition', icon: 'notes', action: 'copydef' },
            ],
        (action) => runAction(action, row.dataset.filter, custom));
    };

    host.addEventListener('click', onClick);
    host.addEventListener('keydown', onKey);
    host.addEventListener('contextmenu', onContextMenu);

    const unsub = onFiltersChanged(render);
    const sub = _eventBus?.on?.('backlog:changed', () => render());

    return {
        render,
        destroy: () => {
            unsub();
            sub?.dispose?.();
            host.removeEventListener('click', onClick);
            host.removeEventListener('keydown', onKey);
            host.removeEventListener('contextmenu', onContextMenu);
        },
    };
}

/* ── content map ─────────────────────────────────────────────────── */

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
