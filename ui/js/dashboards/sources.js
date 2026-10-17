/**
 * sources.js — the stores a dashboard tile can chart (STORY-0036): this page's
 * bugs and backlog, read from the same live data, the same field catalogue and
 * the same filters the Bugs and Backlog views use.
 *
 * FIELDS ARE BUILT LIVE, on every call. The views' catalogues (`FILTER_FIELDS`
 * in filters.js and backlog_filters.js) are fixed when the module loads, so a
 * custom field removed in Settings › Record types would still be in them until
 * a reload. Here the built-in entries are taken from that catalogue and the
 * custom ones from the schema as it is NOW, and a filter model is built over
 * the result — so a tile over a removed field finds it gone and says so.
 *
 * TRACKER RECORDS (STORY-0038) are a third source wherever the tracker is
 * available. In tracker mode they are this page's own store. On a project page
 * they live in the tracker's COPY of the ticketdesk modules (`/js/ticketdesk@t/`,
 * API at `/t/api`, see ticketdesk/instance.js): `loadTracker()` imports that
 * copy's data, filters, schema and instance once the page has loaded it, and the
 * source reads that copy's `ITEMS` only, never the project's backlog. With the
 * tracker switched off the copy is never imported and there is no such source.
 */

import { CONFIG, KIND, apiUrl, has, trackerModule } from '../ticketdesk/instance.js';
import { createFilterModel } from '../ticketdesk/filter_engine.js';
import * as schema from '../ticketdesk/schema.js';
import * as data from '../ticketdesk/data.js';
import * as backlogData from '../ticketdesk/backlog_data.js';
import * as bugFilters from '../ticketdesk/filters.js';
import * as backlogFilters from '../ticketdesk/backlog_filters.js';

const { CF_PREFIX, CATEGORY_LABEL } = schema;

/** A source's name in the tile editor: standalone TicketDesk's backlog is its Tickets. */
const sourceLabel = (store) => (store === 'bugs' ? 'Bugs' : CONFIG.mode === 'tracker' ? 'Tickets' : 'Backlog');

/** The virtual "Status category" field, over a store's own categories. */
const categoryField = (statusCategory, store, typeOf, statusOf) => ({
    key: 'statusCategory', label: 'Status category', type: 'enum', virtual: true,
    options: Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label })),
    get: (r) => statusCategory(store, typeOf(r), statusOf(r)),
});

/**
 * The virtual "Due (week)" field: the record's `dueState`, as the store worked
 * it out on load, in the buckets a person chases by. Read from the load-time
 * state, not recomputed, so a bar and the list a click on it opens agree.
 */
export const DUE_BUCKETS = {
    overdue: { label: 'Overdue', states: ['overdue'] },
    week: { label: 'Due this week', states: ['today', 'soon'] },
    later: { label: 'Later', states: ['later'] },
    none: { label: 'No date', states: ['none'] },
    done: { label: 'Closed', states: ['done'] },
};
export const dueBucketOf = (state) =>
    Object.keys(DUE_BUCKETS).find((k) => DUE_BUCKETS[k].states.includes(state || 'none')) || 'none';
export const dueBucketField = () => ({
    key: 'dueBucket', label: 'Due (week)', type: 'enum', virtual: true,
    options: Object.entries(DUE_BUCKETS).map(([value, b]) => ({ value, label: b.label })),
    get: (r) => dueBucketOf(r?.dueState),
    drill: (key) => ({ kind: 'clause', field: 'dueState', op: 'one_of', value: DUE_BUCKETS[key]?.states || ['none'] }),
});

const clause = (field, op, value) => ({ kind: 'clause', field, op, value });

/**
 * What the list and people tiles (STORY-0047) need of a store beyond its
 * filters: who "me" is, the clauses the board's scope and a click-through are
 * made of, how a record opens, and how it reads as a row. Built per copy of
 * the modules, so a tracker row on a project page opens the tracker's ticket
 * and is deleted through the tracker's own API.
 */
/** The records of one type, as picker entries. */
const refsOf = (items, type) => items.filter((r) => r.type === type)
    .map((r) => ({ id: Number(r.id), label: `${r.ref} ${r.title || ''}`.trim() }));

/** A backlog-shaped store (the backlog, or the tracker) over one copy's modules. */
function backlogSpec({ store, bdata, filters, statusCategory, customFilterFields, apiUrl: api, label, listKind, changedEvent,
    human, itemKind, removeItem }) {
    return {
        store,
        filters,
        statusCategory,
        customFilterFields,
        apiUrl: api,
        label,
        extraFields: () => [dueBucketField()],
        rows: () => bdata.ITEMS,
        typeOf: (r) => r.type,
        statusOf: (r) => r.status || '',
        idOf: (r) => Number(r.id),
        createdOf: (r) => r.created,
        updatedOf: (r) => r.updated,
        // Burndown scopes (STORY-0037; projects STORY-0038).
        parentOf: (r) => (Number(r?.parent) ? String(Number(r.parent)) : ''),
        phaseOf: (r) => r.phaseLabel || '',
        dueOf: (r) => bdata.dueOf(r),
        pointsOf: (r) => r.points,
        epics: () => refsOf(bdata.ITEMS, 'epic'),
        projects: () => refsOf(bdata.ITEMS, 'project'),
        phases: () => [...new Set([...bdata.PHASES, ...bdata.ITEMS.map((r) => r.phaseLabel).filter(Boolean)])].sort(),
        listKind,
        listProps: (expr, lbl) => ({ expr, label: lbl, flat: true }),
        changedEvent,
        noun: 'item',
        // The list and people tiles (STORY-0047).
        human,
        scopeClause: (scope) => (scope === 'byme' ? clause('reporter', 'is', human)
            : scope === 'others' ? clause('assignee', 'none_of', ['none', human]) : null),
        openClause: () => clause('ownFinished', 'is', 'no'),
        assigneeClause: (who) => clause('assignee', 'is', who || 'none'),
        assigneeOf: (r) => r.assignee || '',
        dueStateOf: (r) => r.dueState || 'none',
        projectRefOf: (r) => r.projectRef || '',
        projectExpr: (ref) => filters.projectExpr(ref),
        refOf: (r) => bdata.itemRef(r),
        itemKind,
        itemPropsOf: (r) => ({ id: String(r.id), label: bdata.itemLabel(r) || r.ref }),
        removeItem,
        /** One record as a list tile's row: what the old Tracker rows said. */
        listRow: (r) => {
            const state = r.dueState || 'none';
            const over = bdata.dueOverrun(r);
            const due = bdata.dueOf(r);
            return {
                key: String(r.id),
                icon: bdata.TYPE_ICON[r.type] || 'task',
                iconTitle: bdata.typeLabelOf(r.type),
                lead: r.ref,
                title: r.title || '',
                className: 'bd-dash-row',
                cells: [
                    r.assignee ? { text: r.assignee } : { text: 'nobody', tone: 'muted' },
                    state === 'none' ? { text: 'no date', tone: 'muted' } : {
                        text: bdata.duePhrase(r), title: `${due}${r.inheritsDue ? ' (inherited)' : ''}`,
                        tone: state === 'overdue' ? 'danger' : state === 'today' || state === 'soon' ? 'warning' : undefined,
                    },
                    ...(over ? [{ icon: 'warning', tone: 'warning', title: `Due after ${bdata.itemRef(over)} (${bdata.dueOf(over)})` }] : []),
                    { text: bdata.humanizeItemStatus(r.status), className: `bd-status bd-status--${r.status}` },
                ],
            };
        },
    };
}

/**
 * Delete one backlog-shaped record through its own copy's `confirmDelete` (it
 * asks first, and offers to keep the children). → whether it was deleted.
 * Imported on first use: deleting is rare, and the dialog pulls in more.
 */
function removerFor(load) {
    return async (r, { onStatus } = {}) => {
        const { confirmDelete } = await load();
        return !!(await confirmDelete(r, { onStatus }));
    };
}

const TRACKER_MODE = CONFIG.mode === 'tracker';
/** A project page with the global tracker beside it (`[tracker]` on). */
const MERGED_TRACKER = !TRACKER_MODE && !!CONFIG.tracker?.available;

const SPECS = {
    bugs: {
        store: 'bugs',
        filters: bugFilters,
        statusCategory: schema.statusCategory,
        customFilterFields: schema.customFilterFields,
        apiUrl,
        label: sourceLabel('bugs'),
        extraFields: () => [],
        rows: () => data.TICKETS,
        typeOf: (r) => r.rawType || 'bug',
        statusOf: (r) => r.rawStatus || '',
        idOf: (r) => r.bugId,
        createdOf: (r) => r.created,
        updatedOf: (r) => r.sla,
        listKind: 'queues',
        listProps: (expr, label) => ({ expr, label }),
        changedEvent: 'bugs:changed',
        noun: 'bug',
        human: data.HUMAN_AUTHOR,
        scopeClause: (scope) => (scope === 'byme' ? clause('reporter', 'is', data.HUMAN_AUTHOR)
            : scope === 'others' ? { kind: 'group', op: 'AND', children: [
                clause('assignee', 'is_not_empty'), clause('assignee', 'is_not', data.HUMAN_AUTHOR)] } : null),
        // Not finished: the statuses this project calls finished are the ones left out.
        openClause: () => clause('status', 'none_of', [...new Set(data.TICKETS.map((t) => t.rawStatus || '')
            .filter((st) => schema.statusCategory('bugs', 'bug', st) === 'finished'))]),
        assigneeClause: (who) => (who ? clause('assignee', 'is', who) : clause('assignee', 'is_empty')),
        assigneeOf: (r) => r.assignee || '',
        dueStateOf: () => 'none',
        refOf: (r) => r.id,
        itemKind: 'ticket',
        itemPropsOf: (r) => ({ id: r.id, label: `${r.id} — ${r.summary}` }),
        listRow: (r) => ({
            key: String(r.bugId),
            icon: 'bug_report',
            iconTitle: data.typeLabelOf(r.type),
            lead: r.id,
            title: r.summary || '',
            className: 'bd-dash-row',
            cells: [
                r.assignee ? { text: r.assignee } : { text: 'nobody', tone: 'muted' },
                { text: r.status, className: 'bd-dash-row__status' },
            ],
        }),
    },
    backlog: backlogSpec({
        store: 'backlog', bdata: backlogData, filters: backlogFilters,
        statusCategory: schema.statusCategory, customFilterFields: schema.customFilterFields, apiUrl,
        label: sourceLabel('backlog'), listKind: KIND.list, changedEvent: 'backlog:changed',
        human: data.HUMAN_AUTHOR, itemKind: KIND.item, removeItem: removerFor(() => import('../ticketdesk/delete_item.js')),
    }),
    // In tracker mode the tracker IS this page's store; on a project page it is
    // filled in by loadTracker().
    tracker: TRACKER_MODE ? backlogSpec({
        store: 'backlog', bdata: backlogData, filters: backlogFilters,
        statusCategory: schema.statusCategory, customFilterFields: schema.customFilterFields, apiUrl,
        label: 'Tracker', listKind: KIND.list, changedEvent: 'backlog:changed',
        human: data.HUMAN_AUTHOR, itemKind: KIND.item, removeItem: removerFor(() => import('../ticketdesk/delete_item.js')),
    }) : null,
};

let trackerLoad = null;
/**
 * Make the tracker source ready on a project page: import the tracker's copy of
 * the modules, which the page loaded at start (tiling/install.js sets
 * `__BUGDESK_TRACKER_CONFIG__` first). Does nothing, and imports nothing, when
 * the tracker is off. Never rejects: a tracker that cannot be read is a source
 * that is not offered.
 */
export function loadTracker() {
    if (!MERGED_TRACKER || typeof window === 'undefined' || !window.__BUGDESK_TRACKER_CONFIG__) return Promise.resolve(false);
    trackerLoad ??= Promise.all(['backlog_data.js', 'backlog_filters.js', 'schema.js', 'instance.js', 'data.js'].map((f) => trackerModule(f)))
        .then(([bdata, filters, tschema, inst, tdata]) => {
            SPECS.tracker = backlogSpec({
                store: 'backlog', bdata, filters,
                statusCategory: tschema.statusCategory, customFilterFields: tschema.customFilterFields, apiUrl: inst.apiUrl,
                label: 'Tracker', listKind: inst.KIND.list, changedEvent: inst.ev('backlog:changed'),
                human: tdata.HUMAN_AUTHOR, itemKind: inst.KIND.item, removeItem: removerFor(() => trackerModule('delete_item.js')),
            });
            return true;
        })
        .catch((err) => { console.error('[dashboards] the tracker\'s records could not be loaded', err); return false; });
    return trackerLoad;
}

/** Which sources this page has: `{id, label}[]`. */
export function availableSources() {
    const out = [];
    if (!TRACKER_MODE && has('bugs')) out.push({ id: 'bugs', label: SPECS.bugs.label });
    if (!TRACKER_MODE && has('backlog')) out.push({ id: 'backlog', label: SPECS.backlog.label });
    if (SPECS.tracker) out.push({ id: 'tracker', label: SPECS.tracker.label });
    return out;
}

const history = new Map();      // store → Promise<{id: [{date, from, to}]}>

/** Drop the cached status history of a source (it changed), or of all. */
export function invalidateHistory(id) { if (id) history.delete(id); else history.clear(); }

/**
 * A source as it stands now, or null when this page has no such store.
 * `fields` and `model` are built fresh on each call (see the header).
 */
export function getSource(id) {
    const spec = SPECS[id];
    if (!spec || !availableSources().some((s) => s.id === id)) return null;
    const { filters } = spec;
    const fields = [
        ...filters.FILTER_FIELDS.filter((f) => !f.custom),
        categoryField(spec.statusCategory, spec.store, spec.typeOf, spec.statusOf),
        ...spec.extraFields(),
        ...spec.customFilterFields(spec.store),
    ];
    const model = createFilterModel({ fields, noun: spec.noun });
    const typeField = fields.find((f) => f.key === 'type');
    const isFinished = (r, status) => spec.statusCategory(spec.store, spec.typeOf(r), status) === 'finished';
    return {
        ...spec,
        id,
        fields,
        model,
        fieldByKey: (k) => fields.find((f) => f.key === k) || null,
        /** The record types, as values of the `type` filter field. */
        types: () => (typeField?.options || [])
            .map((o) => (typeof o === 'object' ? o : { value: o, label: data.typeLabelOf(o) })),
        /** A custom field's value as written in the file; any other field's comparable value. */
        read: (f, r) => (f.key.startsWith(CF_PREFIX) ? r?.fields?.[f.key.slice(CF_PREFIX.length)] : f.get(r)),
        builtinFilters: () => filters.BUILTIN_FILTERS,
        builtinFilter: (key) => filters.BUILTIN_FILTERS.find((f) => f.key === key) || null,
        savedFilters: () => filters.listFilters(),
        isFinished,
        isFinishedNow: (r) => isFinished(r, spec.statusOf(r)),
        /** Status changes per record id, from History; fetched once until the store changes. */
        history() {
            if (!history.has(id)) {
                const p = fetch(spec.apiUrl(`/dashboards/status_history?store=${spec.store}`))
                    .then((res) => res.json())
                    .then((j) => { if (!j?.ok) throw new Error(j?.error || 'history not available'); return j.history || {}; });
                p.catch(() => history.delete(id));
                history.set(id, p);
            }
            return history.get(id);
        },
    };
}
