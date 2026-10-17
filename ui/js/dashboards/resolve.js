/**
 * resolve.js — a tile's data settings (`config.binding`) into what the FlexDesk
 * tile draws (STORY-0036).
 *
 *   binding = {
 *     source: 'bugs' | 'backlog' | 'tracker',
 *     types?: string[],                 values of the source's `type` field; none = all
 *     filter?: {key} | {expr, label},   a built-in view by key, or an expression
 *                                       (a saved filter is COPIED in: saved filters
 *                                       are per person, a tile may be shared)
 *     plot: 'count' | 'sum' | 'avg' | 'histogram' | 'perWeek',
 *     field?: string,                   what to group by (count / sum / avg on a chart)
 *     split?: string,                   count only: one series per value of this field
 *                                       (STORY-0038: due state per assignee)
 *     valueField?: string,              the numeric field (sum / avg / histogram)
 *     from?, to?: 'YYYY-MM-DD',         perWeek's and burndown's range
 *     unit?: 'points' | 'items',        burndown (bugs: always items)
 *     scope?: {kind: 'epic' | 'project', id} | {kind: 'phase', phase} | {kind: 'all'},
 *                                       burndown over the backlog or the tracker
 *                                       (STORY-0037; a PROJ record STORY-0038)
 *     sort?: 'due' | 'updated' | 'created' | 'ref',   a list tile's order (STORY-0047)
 *     open?: boolean,                   a list tile: open records only (the default)
 *   }
 *
 * A LIST tile (`flexdesk.list`) lists the selected records, a PEOPLE tile
 * (`flexdesk.people`) groups the open ones by assignee (STORY-0047). Both read
 * the same source, types and filter as a chart.
 *
 * THE BOARD'S SCOPE (STORY-0047) is not part of a binding: it is how the whole
 * dashboard is being looked at (Everyone / Assigned by me / Out with others),
 * chosen in its header and handed to every resolve, and to every click-through,
 * so the list a click opens holds the records the tile counted.
 *
 * Everything that can be wrong with a binding — no settings yet, a store this
 * project lacks, a field removed from the schema, a filter that no longer
 * exists — comes back as `{empty: message}`, which the page shows as the tile's
 * empty state. Only a real failure (the history request) rejects.
 *
 * The source is passed in (see sources.js), so this file needs no store and is
 * tested with a plain object.
 */

import {
    aggregate, addDays, andExpr, burndown, drillClause, finishedDay, groupCount, groupCountSplit, keyLabel, kpi,
    numericValues, perWeek, skippedNote, toNumber,
} from './series.js';
import { trackerOffReason } from '../core/app_identity.js';

export const PLOTS = {
    count: 'Count per value',
    sum: 'Sum per value',
    avg: 'Average per value',
    histogram: 'Histogram',
    perWeek: 'Created and finished per week',
    burndown: 'Burndown',
};
export const KPI_PLOTS = { count: 'Number of records', sum: 'Sum', avg: 'Average' };

/** The board's scopes, in the header's order. The source says what each one
 *  means for its records (sources.js `scopeClause`). */
export const SCOPES = Object.freeze([
    { value: 'all', label: 'Everyone' },
    { value: 'byme', label: 'Assigned by me' },
    { value: 'others', label: 'Out with others' },
]);
export const scopeOf = (v) => (SCOPES.some((s) => s.value === v) ? v : 'all');

/** A scope's hint for its button: whose records it keeps. */
export const scopeHint = (scope, human) => ({
    all: 'every record',
    byme: `records whose reporter is ${human || 'you'}`,
    others: `records assigned to somebody who is not ${human || 'you'}`,
})[scopeOf(scope)];

/** The clause a scope adds for `src`, or null (everyone, or a source that cannot say). */
const scopeClause = (src, scope) => (scope && scope !== 'all' && src?.scopeClause ? src.scopeClause(scope) : null);

/** A list tile's orders. */
export const LIST_SORTS = Object.freeze({
    due: 'Target date (the most late first, then the soonest)',
    updated: 'Last updated (newest first)',
    created: 'Created (newest first)',
    ref: 'Reference',
});

/** Plots that read a numeric field. */
export const NUMERIC_PLOTS = new Set(['sum', 'avg', 'histogram']);

const nameOf = (key) => String(key || '').replace(/^cf\./, '');
const removed = (key) => ({ empty: `The field '${nameOf(key)}' is no longer in this project's schema, so this tile has nothing to show. Pick another field in the tile's settings.` });

/** The filter a binding names, as `{expr, label}`, or `{empty}` when it cannot be used. */
export function filterOf(src, binding) {
    const f = binding.filter;
    if (!f) return { expr: null, label: '' };
    if (f.key) {
        const b = src.builtinFilter(f.key);
        return b ? { expr: b.expr, label: b.label } : { empty: `The filter '${f.key}' no longer exists. Pick another one in the tile's settings.` };
    }
    if (f.expr) {
        const unknown = src.model.unknownFields(f.expr);
        return unknown.length ? removed(unknown[0]) : { expr: f.expr, label: f.label || src.model.describeFilter(f.expr) };
    }
    return { expr: null, label: '' };
}

const typesClause = (binding) => (Array.isArray(binding.types) && binding.types.length
    ? { kind: 'clause', field: 'type', op: 'one_of', value: binding.types } : null);

/**
 * Check a binding against the source as it is now.
 * → `{field, valueField, filter}` or `{empty}`.
 */
export function check(src, binding, kind = 'chart') {
    if (!binding || typeof binding !== 'object' || !binding.source) {
        return { empty: 'This tile has no data settings yet. Open its settings to choose what it shows.' };
    }
    if (!src && binding.source === 'tracker') {
        // Switched off is said as such (STORY-0043): the tile is kept, and shows
        // again once the Tracker is back.
        const off = trackerOffReason();
        return { empty: off
            ? `${off} This tile shows tracker records, so it has nothing to show until then.`
            : 'The tracker is not available here (it is switched off, or could not be loaded), so this tile has nothing to show.' };
    }
    if (!src) return { empty: `This project has no ${binding.source} store, so this tile has nothing to show.` };
    const plot = binding.plot || 'count';
    const wantsField = kind === 'chart' && (plot === 'count' || plot === 'sum' || plot === 'avg');
    const wantsValue = NUMERIC_PLOTS.has(plot);
    let field = null, valueField = null, split = null;
    if (wantsField) {
        if (!binding.field) return { empty: 'Choose a field to group by in the tile\'s settings.' };
        field = src.fieldByKey(binding.field);
        if (!field) return removed(binding.field);
        if (plot === 'count' && binding.split) {
            split = src.fieldByKey(binding.split);
            if (!split) return removed(binding.split);
        }
    }
    if (wantsValue) {
        if (!binding.valueField) return { empty: 'Choose a number field in the tile\'s settings.' };
        valueField = src.fieldByKey(binding.valueField);
        if (!valueField) return removed(binding.valueField);
        if (valueField.type !== 'number') return { empty: `'${valueField.label}' is not a number field, so it cannot be summed or averaged.` };
    }
    const filter = filterOf(src, binding);
    if (filter.empty) return filter;
    return { plot, field, valueField, split, filter };
}

/** The rows a binding selects: its types, its filter, and the board's scope. */
export function rowsFor(src, binding, filter, scope = 'all') {
    const match = src.model.matcherFor(andExpr(filter.expr, typesClause(binding), scopeClause(src, scope)));
    return src.rows().filter(match);
}

const todayISO = () => new Date().toISOString().slice(0, 10);

/** A real calendar day as `YYYY-MM-DD` (not "2026-13-45", not "soon"). */
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
    && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/**
 * A tile's data: `{data}` for the tile's `setData`, or `{empty}`.
 * @param {'chart'|'kpi'} kind
 */
export async function resolveTile(src, binding, { kind = 'chart', today = todayISO(), scope = 'all' } = {}) {
    const c = check(src, binding, kind);
    if (c.empty) return c;
    const { plot, field, valueField, split, filter } = c;
    const rows = rowsFor(src, binding, filter, scope);
    if (kind === 'list') return listTile(src, binding, rows);
    if (kind === 'people') return peopleTile(src, rows, today);
    const readValue = valueField ? (r) => src.read(valueField, r) : null;
    const valueNote = (skipped) => skippedNote(skipped, `${valueField?.label || ''} value`.trim());

    if (kind === 'kpi') {
        const { value, skipped } = kpi(rows, plot, readValue);
        if (value === null) return { empty: `No ${valueField.label} values to ${plot === 'avg' ? 'average' : 'add up'}.` + (skipped ? ` ${valueNote(skipped)}.` : '') };
        const what = plot === 'count' ? (filter.label || `All ${src.label.toLowerCase()}`)
            : `${KPI_PLOTS[plot]} of ${valueField.label}${filter.label ? ` · ${filter.label}` : ''}`;
        return { data: { value, label: what, note: valueNote(skipped) || undefined } };
    }

    if (plot === 'count' && split) {
        const g = groupCountSplit(rows, field, split);
        if (!g.keys.length) return { empty: 'No records match this tile\'s filter.' };
        return { data: { series: g.series.map((s) => ({
            x: g.x, y: s.y, name: keyLabel(split, s.key), customdata: g.keys.map((k) => [k, s.key]),
        })) } };
    }
    if (plot === 'count') {
        const g = groupCount(rows, field);
        if (!g.keys.length) return { empty: 'No records match this tile\'s filter.' };
        return { data: { series: [{ x: g.x, y: g.y, name: 'Records', customdata: g.keys }] } };
    }
    if (plot === 'sum' || plot === 'avg') {
        const g = aggregate(rows, field, readValue, plot);
        const note = valueNote(g.skipped);
        if (!g.keys.length) return { empty: `No ${valueField.label} values to show.` + (note ? ` ${note}.` : '') };
        return { data: { series: [{ x: g.x, y: g.y, name: `${PLOTS[plot].split(' ')[0]} of ${valueField.label}`, customdata: g.keys }], note } };
    }
    if (plot === 'histogram') {
        const { values, skipped } = numericValues(rows, readValue);
        const note = valueNote(skipped);
        if (!values.length) return { empty: `No ${valueField.label} values to show.` + (note ? ` ${note}.` : '') };
        return { data: { series: [{ values, name: valueField.label }], note } };
    }
    if (plot === 'burndown') return burndownTile(src, binding, rows, today);
    if (plot === 'perWeek') {
        const to = binding.to || today;
        const bad = [binding.from, binding.to].find((d) => d && !isDay(d));
        if (bad !== undefined) return { empty: `'${bad}' is not a date (YYYY-MM-DD). Fix the range in the tile's settings.` };
        const from = binding.from || addDays(to, -7 * 12 + 1);
        if (from > to) return { empty: 'The date range ends before it starts.' };
        const hist = await src.history();
        const w = perWeek(rows, {
            created: src.createdOf,
            finished: (r) => (src.isFinishedNow(r)
                ? finishedDay(hist[String(src.idOf(r))], (s) => src.isFinished(r, s), src.updatedOf(r)) : ''),
        }, { from, to });
        return { data: {
            series: [{ x: w.x, y: w.created, name: 'Created' }, { x: w.x, y: w.finished, name: 'Finished' }],
            xKind: 'date',
            note: `Weeks from ${from} to ${to}. Finished: the day History shows it moved to a finished status.`,
        } };
    }
    return { empty: `This tile asks for '${plot}', which this BugDesk cannot draw.` };
}

/* ── the list and people tiles (STORY-0047) ─────────────────────── */

const byRef = (src) => (a, b) => (Number(src.idOf(a)) || 0) - (Number(src.idOf(b)) || 0);

/** `rows` in a list tile's order. Records with no date (or no stamp) go last. */
export function sortRows(src, rows, sort = 'due') {
    const ref = byRef(src);
    const stamp = (get) => (r) => String(get?.(r) || '');
    const desc = (get) => (a, b) => (stamp(get)(b) || '').localeCompare(stamp(get)(a) || '') || ref(a, b);
    const out = [...rows];
    if (sort === 'updated') return out.sort(desc(src.updatedOf));
    if (sort === 'created') return out.sort(desc(src.createdOf));
    if (sort === 'due' && src.dueOf) {
        return out.sort((a, b) => {
            const da = src.dueOf(a) || '', db = src.dueOf(b) || '';
            if (!da !== !db) return da ? -1 : 1;
            return da.localeCompare(db) || ref(a, b);
        });
    }
    return out.sort(ref);
}

/** A list tile's data: its records as rows, open ones only unless it says otherwise. */
function listTile(src, binding, rows) {
    const shown = binding.open === false ? rows : rows.filter((r) => !src.isFinishedNow(r));
    if (!src.listRow) return { empty: `${src.label} records cannot be listed in a tile.` };
    return { data: {
        rows: sortRows(src, shown, binding.sort).map((r) => src.listRow(r)),
        action: { label: 'Open as a list', icon: 'list' },
    } };
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/**
 * Who has open work, worst first: by the number overdue, then by how late the
 * worst one is, then by how much is open. Not alphabetically — the list is
 * read top-down and stopped at, so the order has to BE the priority. Work on
 * nobody is a row of its own, "Nobody": a real and urgent bucket.
 */
export function peopleOf(src, rows, today = todayISO()) {
    const by = new Map();
    for (const r of rows) {
        if (src.isFinishedNow(r)) continue;
        const who = src.assigneeOf ? src.assigneeOf(r) : '';
        if (!by.has(who)) by.set(who, { who, open: 0, overdue: 0, undated: 0, worst: 0, next: '' });
        const p = by.get(who);
        p.open++;
        const state = src.dueStateOf ? src.dueStateOf(r) : 'none';
        const due = src.dueOf ? src.dueOf(r) : '';
        if (state === 'overdue') {
            p.overdue++;
            if (isDay(due)) p.worst = Math.max(p.worst, -daysBetween(today, due));
        } else if (state === 'none') p.undated++;
        else if (due && (!p.next || due < p.next)) p.next = due;
    }
    return [...by.values()].sort((a, b) => b.overdue - a.overdue || b.worst - a.worst || b.open - a.open
        || String(a.who).localeCompare(String(b.who)));
}

function peopleTile(src, rows, today) {
    const dated = !!src.dueOf;
    return { data: { people: peopleOf(src, rows, today).map((p) => ({
        key: p.who,
        name: p.who || 'Nobody',
        muted: !p.who,
        icon: p.who ? (p.who.endsWith('_agent') ? 'smart_toy' : 'person') : 'person_off',
        count: p.open,
        title: `Show everything open on ${p.who || 'nobody'}`,
        pills: dated ? [
            p.overdue ? { text: `${p.overdue} overdue`, tone: 'danger' } : null,
            p.undated ? { text: `${p.undated} undated`, tone: 'muted' } : null,
            p.next ? { text: `next ${p.next}` } : null,
        ].filter(Boolean) : [],
    })) } };
}

/** The records a list tile lists, for its "Open as a list": `{expr, label}` or null. */
export function listDrill(src, binding, title = '', scope = 'all') {
    const c = check(src, binding, 'list');
    if (c.empty) return null;
    const expr = andExpr(c.filter.expr, typesClause(binding), binding.open === false ? null : src.openClause?.(), scopeClause(src, scope));
    return { expr, label: title || c.filter.label || `${src.label}` };
}

/** One person's open records, as a people tile's row opens them: `{expr, label}` or null. */
export function personDrill(src, binding, who, scope = 'all') {
    const c = check(src, binding, 'people');
    if (c.empty || !src.assigneeClause) return null;
    const expr = andExpr(c.filter.expr, typesClause(binding), src.openClause?.(), scopeClause(src, scope), src.assigneeClause(who));
    return { expr, label: who ? `On ${who}` : 'Nobody on it' };
}

/** The rows of a backlog burndown's scope, and its own due date. → `{rows, due}` or `{empty}`. */
function scopeRows(src, scope, rows) {
    if (!src.parentOf || !scope || scope.kind === 'all' || !scope.kind) return { rows, due: '' };
    if (scope.kind === 'phase') {
        if (!scope.phase) return { empty: 'Choose a phase in the tile\'s settings.' };
        return { rows: rows.filter((r) => src.phaseOf(r) === scope.phase), due: '' };
    }
    if (scope.kind === 'epic' || scope.kind === 'project') {
        const all = src.rows();
        const epic = all.find((r) => String(src.idOf(r)) === String(scope.id));
        if (!epic) return { empty: `The ${scope.kind} #${scope.id} no longer exists. Pick another one in the tile's settings.` };
        const byId = new Map(all.map((r) => [String(src.idOf(r)), r]));
        const under = (r) => {          // any ancestor is the epic (cycles stop)
            const seen = new Set();
            for (let p = src.parentOf(r); p && !seen.has(p); p = src.parentOf(byId.get(p))) {
                if (p === String(scope.id)) return true;
                seen.add(p);
            }
            return false;
        };
        return { rows: rows.filter(under), due: src.dueOf(epic) };
    }
    return { empty: `This tile's scope '${scope.kind}' is not one BugDesk knows.` };
}

/** A burndown tile's data (STORY-0037). */
async function burndownTile(src, binding, filtered, today) {
    const bad = [binding.from, binding.to].find((d) => d && !isDay(d));
    if (bad !== undefined) return { empty: `'${bad}' is not a date (YYYY-MM-DD). Fix the range in the tile's settings.` };
    const sc = scopeRows(src, binding.scope, filtered);
    if (sc.empty) return sc;
    const { rows } = sc;
    if (!rows.length) return { empty: 'No records are in this burndown\'s scope.' };
    const points = binding.unit === 'points' && !!src.pointsOf;
    // Only real days: a hand-written `due: soon` must not become the end (the day loop would never stop).
    const dues = (sc.due ? [sc.due] : binding.scope?.kind === 'phase' ? rows.map((r) => src.dueOf(r)) : []).filter(isDay);
    const from = binding.from || rows.map((r) => String(src.createdOf(r) || '').slice(0, 10)).filter(isDay).sort()[0] || today;
    const to = binding.to || dues.sort().at(-1) || today;
    if (from > to) return { empty: `The date range ends (${to}) before it starts (${from}).` };
    const hist = await src.history();
    const b = burndown(rows, {
        created: src.createdOf,
        updated: src.updatedOf,
        status: src.statusOf,
        history: (r) => hist[String(src.idOf(r))],
        finished: src.isFinished,
        weight: points ? (r) => {
            const raw = src.pointsOf(r);
            if (raw === null || raw === undefined || String(raw).trim() === '') return 0;
            return toNumber(raw);
        } : () => 1,
    }, { from, to, today });
    const what = points ? 'points' : src.id === 'bugs' ? 'open bugs' : 'items';
    const notes = [];
    if (points) notes.push('Points are current estimates: History does not record re-estimates, so a re-estimate changes the past of this chart.');
    if (b.skipped) notes.push(`${skippedNote(b.skipped, 'estimate')}.`);
    notes.push('Scope falls when an item is dropped; Remaining falls when one is finished.');
    return { data: {
        series: [
            { x: b.x, y: b.remaining, name: `Remaining ${what}`, interpolation: 'step' },
            { x: b.x, y: b.scope, name: 'Scope', interpolation: 'step', lineStyle: 'dotted' },
            { x: b.ideal.x, y: b.ideal.y, name: 'Ideal', lineStyle: 'dashed' },
        ],
        markers: b.today ? [{ x: b.today, label: 'Today' }] : [],
        xKind: 'date',
        note: notes.join(' '),
    } };
}

/**
 * The records behind one bar or slice, for the list view: the tile's filter and
 * types AND the clicked group. → `{expr, label}` or null.
 */
export function drillExpr(src, binding, key, title = '', scope = 'all') {
    const c = check(src, binding, 'chart');
    if (c.empty || !c.field) return null;
    // A split chart's point is `[group, split]`.
    const [k, sk] = c.split && Array.isArray(key) ? key : [key, undefined];
    const clauseFor = (field, value) => {
        if (field.drill) return field.drill(value);
        if (field.virtual) {
            // Status category is not a field the list views know: name the statuses
            // the matching records are in instead.
            const statuses = [...new Set(rowsFor(src, binding, c.filter, scope)
                .filter((r) => field.get(r) === value).map((r) => src.statusOf(r)))];
            return { kind: 'clause', field: 'status', op: 'one_of', value: statuses };
        }
        return drillClause(field, value);
    };
    const clause = clauseFor(c.field, k);
    const splitClause = c.split && sk !== undefined ? clauseFor(c.split, sk) : null;
    if (!clause || (sk !== undefined && c.split && !splitClause)) return null;
    const expr = andExpr(c.filter.expr, typesClause(binding), scopeClause(src, scope), clause, splitClause);
    const label = `${title || c.field.label}: ${keyLabel(c.field, k)}${splitClause ? ` · ${keyLabel(c.split, sk)}` : ''}`;
    return { expr, label };
}
