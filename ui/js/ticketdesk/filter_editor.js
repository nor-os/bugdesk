/**
 * ticketdesk/filter_editor.js — a BugDesk custom filter in FlexDesk's filter
 * dialog: its name, its icon and its expression, with a live preview of the
 * records the expression matches.
 *
 * What a filter means is the model's; the conditions, the focus trap and the
 * discard question are the dialog's. What is BugDesk's here is where a filter is
 * kept (./filter_store.js) and how a matching record reads in the preview.
 */

import { openFilterDialog } from '@flexdesk/widgets';
import { FILTER_ICONS } from './filter_engine.js';
import { saveFilter, deleteFilter } from './filter_store.js';
import { esc } from './data.js';

/* Maximum number of matching records listed in the preview pane. */
const PREVIEW_LIMIT = 25;

/** One preview row. The bug shape is the default because it was the only shape
 *  when this existed; a caller over different rows passes `rowLabel` and gets the
 *  same list without a second renderer. */
const bugRowLabel = (t) => ({
    id: t.id,
    title: t.summary || '',
    status: t.status || '',
    dot: String(t.severity || '').toLowerCase() || 'low',
    dotTitle: t.severity || '',
});

const hitHtml = (r) => `
    <li class="bd-fprev__hit">
        <span class="bd-fprev__hitid">${esc(r.id ?? '')}</span>
        <span class="bd-fprev__dot bd-fprev__dot--${esc(r.dot || 'low')}" title="${esc(r.dotTitle || '')}"></span>
        <span class="bd-fprev__hittitle">${esc(r.title ?? '')}</span>
        <span class="bd-fprev__hitstatus">${esc(r.status ?? '')}</span>
    </li>`;

/**
 * Open the filter editor.
 *
 * @param {object}   o
 * @param {object?}  o.filter    existing filter to edit (Cancel is lossless).
 *                               Falsy → create mode.
 * @param {object?}  o.seedExpr  expression to pre-populate in create mode
 *                               (the queue's "Save as filter" button).
 * @param {object}   o.model     the bound filter model whose fields this
 *                               filter is written against — ./filters.js's for
 *                               a bug filter, ./backlog_filters.js's for a
 *                               backlog one.
 * @param {string}   o.scope     which store the saved filter belongs to
 *                               ('bugs' | 'backlog'). Keeps the two rails from
 *                               listing each other's filters.
 * @param {Array}    o.items     the rows driving the live preview.
 * @param {Function?} o.rowLabel one preview row → its display text. Defaults to
 *                               the bug shape; the backlog passes its own.
 * @param {Function?} o.onSaved  called with the persisted filter after Save.
 * @param {Function?} o.onDeleted called with the id after Delete.
 * @param {Function?} o.onPick   a CONDITION for something else (an alert rule):
 *                               Save hands back `{label, expr}` and stores nothing
 *                               in the user's filters.
 */
export async function openFilterEditor({
    model, scope = 'bugs', filter = null, seedExpr = null, items = [],
    rowLabel = bugRowLabel, onSaved = null, onDeleted = null, onPick = null,
} = {}) {
    if (!model) throw new Error('openFilterEditor needs a filter model');
    const id = filter && !filter.builtin ? (filter.id || null) : null;
    const label = filter?.label || '';
    const noun = model.noun;
    let saved = null;

    const preview = (host, { expr }) => {
        const match = model.matcherFor(expr);
        const hits = items.filter((t) => match(t));
        const more = hits.length - PREVIEW_LIMIT;
        host.innerHTML = `
            <div class="bd-fprev__count">
                <b>${hits.length}</b> of ${items.length} ${esc(noun)}${items.length === 1 ? '' : 's'} match${hits.length === 1 ? 'es' : ''}
            </div>
            ${hits.length
                ? `<ul class="bd-fprev__list">${hits.slice(0, PREVIEW_LIMIT).map((t) => hitHtml(rowLabel(t) || {})).join('')}</ul>
                   ${more > 0 ? `<div class="bd-fprev__more">+ ${more} more not shown</div>` : ''}`
                : `<div class="bd-fprev__none">
                       <span class="material-symbols-outlined">search_off</span>
                       No ${esc(noun)} matches this filter.
                   </div>`}`;
    };

    const onSubmit = async ({ name, icon, expr }) => {
        if (onPick) return;
        try {
            saved = await saveFilter({ id, scope, label: name, icon, expr, builtin: false }, scope);
        } catch (err) {
            throw new Error(`Save failed: ${err?.message ?? err}`);
        }
    };

    const remove = async () => {
        try {
            await deleteFilter(id);
        } catch (err) {
            throw new Error(`Delete failed: ${err?.message ?? err}`);
        }
    };

    const result = await openFilterDialog({
        model,
        value: filter ? filter.expr : seedExpr,
        title: id ? 'Edit filter' : 'New filter',
        name: { value: label, placeholder: 'e.g. Crashers on me' },
        iconChoice: { value: filter?.icon || FILTER_ICONS[0], options: FILTER_ICONS },
        confirmDiscard: true,
        dismissOnBackdrop: true,
        submitLabel: 'Save',
        onSubmit,
        preview,
        actions: id ? [{
            label: 'Delete',
            value: 'delete',
            danger: true,
            confirm: {
                title: 'Delete this filter?',
                message: ({ name }) => `"${name || label}" will be removed from the filter rail. This cannot be undone.`,
                confirmLabel: 'Delete',
                danger: true,
            },
            run: remove,
        }] : [],
    });

    if (result?.action === 'delete') onDeleted?.(id);
    else if (result?.action === 'submit') {
        if (onPick) onPick({ label: result.name, expr: result.expr });
        else onSaved?.(saved);
    }
}
