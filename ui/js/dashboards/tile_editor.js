/**
 * tile_editor.js — a tile's settings dialog (STORY-0036): what it charts, then
 * how it looks.
 *
 * The DATA part is BugDesk's: the store, its record types, a filter (a built-in
 * view, or one of the person's saved filters, COPIED into the tile because saved
 * filters are per person and a tile may be shared), what to plot, and over which
 * field. The field picker lists every field of the chosen store, custom fields
 * included; the number-field picker, which is what sum, average and histogram
 * read, lists only number fields. The DISPLAY part is the FlexDesk tile's own
 * config schema, shown as it is.
 *
 * Every store's pickers are built once and the ones not chosen are hidden
 * (`openForm` keeps hidden rows out of validation), so switching the store
 * back and forth loses nothing.
 */

import { openForm } from '@flexdesk/widgets';
import { KPI_PLOTS, LIST_SORTS, NUMERIC_PLOTS, PLOTS, check } from './resolve.js';

/** A list or people tile (STORY-0047): records, types and a filter, no plot. */
const isRows = (kind) => kind === 'list' || kind === 'people';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const typeName = (src, value) => `bd_t_${src.id}_${String(value).replace(/[^A-Za-z0-9_-]/g, '_')}`;

/** FlexDesk config schema → openForm fields. */
function displayFields(schema) {
    return (schema?.fields || []).map((f) => ({
        name: f.name,
        label: f.label || f.name,
        type: ['text', 'number', 'select', 'checkbox'].includes(f.type) ? f.type : 'text',
        options: f.options,
        hint: f.help,
    }));
}

function filterOptions(src, binding) {
    const opts = [{ value: '', label: 'All records' }];
    for (const f of src.builtinFilters()) opts.push({ value: `key:${f.key}`, label: f.label });
    for (const f of src.savedFilters()) opts.push({ value: `saved:${f.id}`, label: `Saved: ${f.label}` });
    if (binding?.source === src.id && binding.filter?.expr) {
        opts.push({ value: 'keep', label: `This tile's filter: ${binding.filter.label || src.model.describeFilter(binding.filter.expr)}` });
    }
    return opts;
}

function filterValue(binding) {
    const f = binding?.filter;
    if (!f) return '';
    return f.key ? `key:${f.key}` : f.expr ? 'keep' : '';
}

const fieldOption = (f) => ({ value: f.key, label: f.custom ? `${f.label} (custom field)` : f.label });

/**
 * The data fields of the form, and their starting values.
 * @param {object[]} sources  available sources (sources.js `getSource`)
 */
export function dataFields(sources, binding, kind, preferred = null) {
    const fields = [{ section: 'Data', name: 'bd_data' }];
    const defaults = {};
    // A new tile reads the dashboard's own section first (the Tracker home's: tracker records).
    const chosen = sources.some((s) => s.id === binding?.source) ? binding.source
        : sources.some((s) => s.id === preferred) ? preferred : sources[0]?.id;
    fields.push({ name: 'bd_source', label: 'Records', type: 'select',
        options: sources.map((s) => ({ value: s.id, label: s.label })) });
    defaults.bd_source = chosen;

    if (isRows(kind)) return rowsFields(sources, binding, kind, fields, defaults);

    const plots = kind === 'kpi' ? KPI_PLOTS : PLOTS;
    fields.push({ name: 'bd_plot', label: kind === 'kpi' ? 'Show' : 'Plot', type: 'select',
        options: Object.entries(plots).map(([value, label]) => ({ value, label })) });
    defaults.bd_plot = plots[binding?.plot] ? binding.plot : 'count';

    for (const src of sources) {
        const mine = binding?.source === src.id ? binding : null;
        fields.push({ section: 'Record types (none ticked: all of them)', name: `bd_types_${src.id}` });
        for (const t of src.types()) {
            fields.push({ name: typeName(src, t.value), label: t.label, type: 'checkbox' });
            defaults[typeName(src, t.value)] = !!mine?.types?.includes(t.value);
        }
        fields.push({ name: `bd_filter_${src.id}`, label: 'Filter', type: 'select', options: filterOptions(src, mine),
            hint: 'A saved filter is copied into the tile, so everyone who sees the tile sees the same records.' });
        defaults[`bd_filter_${src.id}`] = filterValue(mine);

        fields.push({ name: `bd_field_${src.id}`, label: 'Group by', type: 'select',
            options: src.fields.map(fieldOption),
            validator: (v) => (v ? null : 'Choose a field to group by.') });
        defaults[`bd_field_${src.id}`] = mine?.field && src.fieldByKey(mine.field) ? mine.field : (src.fieldByKey('status') ? 'status' : src.fields[0]?.key);
        fields.push({ name: `bd_split_${src.id}`, label: 'Split by', type: 'select',
            options: [{ value: '', label: 'Nothing (one series)' }, ...src.fields.map(fieldOption)],
            hint: 'One series per value, e.g. Assignee split by Due (week). A stacked bar chart shows it best.' });
        defaults[`bd_split_${src.id}`] = mine?.split && src.fieldByKey(mine.split) ? mine.split : '';

        const numeric = src.fields.filter((f) => f.type === 'number');
        fields.push({ name: `bd_value_${src.id}`, label: 'Number field', type: 'select',
            options: numeric.map(fieldOption),
            hint: 'Sum, average and histogram work on number fields only.',
            validator: (v) => (v ? null : numeric.length ? 'Choose a number field.' : 'These records have no number field.') });
        defaults[`bd_value_${src.id}`] = mine?.valueField && numeric.some((f) => f.key === mine.valueField)
            ? mine.valueField : (numeric.find((f) => f.key === 'points') || numeric[0])?.key || '';
    }

    const scoped = sources.filter((s) => s.epics);
    if (kind !== 'kpi' && scoped.length) {
        // Burndown (STORY-0037): its unit and scope, over the backlog or the
        // tracker (STORY-0038: a PROJ record). The pickers are per store.
        fields.push({ name: 'bd_unit', label: 'Count', type: 'select',
            options: [{ value: 'points', label: 'Points' }, { value: 'items', label: 'Items' }] });
        fields.push({ name: 'bd_scope', label: 'Scope', type: 'select',
            options: [{ value: 'all', label: 'All records' }, { value: 'epic', label: 'One epic' },
                { value: 'phase', label: 'One phase' }, { value: 'project', label: 'One project' }] });
        const burn = binding?.plot === 'burndown' ? binding : null;
        defaults.bd_unit = burn?.unit === 'items' ? 'items' : 'points';
        defaults.bd_scope = ['epic', 'phase', 'project'].includes(burn?.scope?.kind) ? burn.scope.kind : 'all';
        for (const src of scoped) {
            const mine = burn?.source === src.id ? burn : null;
            const pick = (name, label, list, hint) => {
                fields.push({ name: `bd_${name}_${src.id}`, label, type: 'select', hint,
                    options: list.map((e) => (typeof e === 'object' ? { value: String(e.id), label: e.label } : { value: e, label: e })),
                    validator: (v) => (v ? null : list.length ? `Choose ${label === 'Epic' ? 'an' : 'a'} ${label.toLowerCase()}.` : `These records have no ${label.toLowerCase()}.`) });
                const first = list[0];
                defaults[`bd_${name}_${src.id}`] = mine?.scope?.kind === name
                    ? String(name === 'phase' ? mine.scope.phase : mine.scope.id)
                    : String((typeof first === 'object' ? first?.id : first) ?? '');
            };
            pick('epic', 'Epic', src.epics(), 'The epic and everything under it.');
            pick('phase', 'Phase', src.phases());
            pick('project', 'Project', src.projects(), 'The project and everything under it.');
        }
    }

    if (kind !== 'kpi') {
        const dateCheck = (v) => (!v || DATE_RE.test(String(v).trim()) ? null : 'A date as YYYY-MM-DD, or empty.');
        fields.push({ name: 'bd_from', label: 'From', type: 'text', placeholder: 'YYYY-MM-DD (empty: the default)', validator: dateCheck,
            hint: 'Empty: 12 weeks back; for a burndown, the earliest created record.' });
        fields.push({ name: 'bd_to', label: 'To', type: 'text', placeholder: 'YYYY-MM-DD (empty: the default)', validator: dateCheck,
            hint: 'Empty: today; for a burndown, the epic\'s or project\'s due date (or the phase\'s latest), else today.' });
        defaults.bd_from = binding?.from || '';
        defaults.bd_to = binding?.to || '';
    }
    fields.push({ section: 'Display', name: 'bd_display' });
    return { fields, defaults };
}

/** The orders a list over `src` can take: by target date only where the store has them. */
const listSortsOf = (src) => (src.dueOf ? LIST_SORTS
    : Object.fromEntries(Object.entries(LIST_SORTS).filter(([value]) => value !== 'due')));
const defaultSortOf = (src) => (src.dueOf ? 'due' : 'updated');

/** The types and filter of each store, and a list's order: a list or people tile's data part. */
function rowsFields(sources, binding, kind, fields, defaults) {
    for (const src of sources) {
        const mine = binding?.source === src.id ? binding : null;
        fields.push({ section: 'Record types (none ticked: all of them)', name: `bd_types_${src.id}` });
        for (const t of src.types()) {
            fields.push({ name: typeName(src, t.value), label: t.label, type: 'checkbox' });
            defaults[typeName(src, t.value)] = !!mine?.types?.includes(t.value);
        }
        fields.push({ name: `bd_filter_${src.id}`, label: kind === 'people' ? 'Of the records' : 'Filter', type: 'select',
            options: filterOptions(src, mine),
            hint: 'A saved filter is copied into the tile, so everyone who sees the tile sees the same records.' });
        defaults[`bd_filter_${src.id}`] = filterValue(mine);
        // A store without target dates (bugs) is not offered an order by them.
        if (kind === 'list') {
            const sorts = listSortsOf(src);
            fields.push({ name: `bd_sort_${src.id}`, label: 'Order', type: 'select',
                options: Object.entries(sorts).map(([value, label]) => ({ value, label })) });
            defaults[`bd_sort_${src.id}`] = sorts[mine?.sort] ? mine.sort : defaultSortOf(src);
        }
    }
    if (kind === 'list') {
        fields.push({ name: 'bd_open', label: 'Open records only', type: 'checkbox',
            hint: 'Leave a finished record out even when the filter would list it.' });
        defaults.bd_open = binding?.open !== false;
    }
    fields.push({ section: 'Display', name: 'bd_display' });
    return { fields, defaults };
}

/** Show the chosen store's pickers and the ones the chosen plot reads. */
export function syncVisibility(api, sources, kind) {
    const source = api.get('bd_source');
    if (isRows(kind)) {
        for (const src of sources) {
            const on = src.id === source;
            api.setVisible(`bd_types_${src.id}`, on);
            for (const t of src.types()) api.setVisible(typeName(src, t.value), on);
            api.setVisible(`bd_filter_${src.id}`, on);
            api.setVisible(`bd_sort_${src.id}`, on);
        }
        return;
    }
    const plot = api.get('bd_plot');
    for (const src of sources) {
        const on = src.id === source;
        api.setVisible(`bd_types_${src.id}`, on);
        for (const t of src.types()) api.setVisible(typeName(src, t.value), on);
        api.setVisible(`bd_filter_${src.id}`, on);
        api.setVisible(`bd_field_${src.id}`, on && kind !== 'kpi' && ['count', 'sum', 'avg'].includes(plot));
        api.setVisible(`bd_split_${src.id}`, on && kind !== 'kpi' && plot === 'count');
        api.setVisible(`bd_value_${src.id}`, on && NUMERIC_PLOTS.has(plot));
    }
    const dated = plot === 'perWeek' || plot === 'burndown';
    api.setVisible('bd_from', dated);
    api.setVisible('bd_to', dated);
    const burn = plot === 'burndown' && !!sources.find((s) => s.id === source)?.epics;
    if (sources.some((s) => s.epics) && kind !== 'kpi') {
        const scope = api.get('bd_scope');
        api.setVisible('bd_unit', burn);
        api.setVisible('bd_scope', burn);
        for (const src of sources.filter((s) => s.epics)) {
            for (const name of ['epic', 'phase', 'project']) {
                api.setVisible(`bd_${name}_${src.id}`, burn && src.id === source && scope === name);
            }
        }
    }
}

/** A chart type that suits the plot, when the one set does not. */
function suitChartType(api, plot) {
    const type = api.get('chart_type');
    if (type === undefined) return;
    if (plot === 'histogram') api.set('chart_type', 'histogram');
    else if (plot === 'burndown') api.set('chart_type', 'line');
    else if (plot === 'perWeek' && !['line', 'area', 'bar', 'bar-stacked'].includes(type)) api.set('chart_type', 'line');
    else if (['count', 'sum', 'avg'].includes(plot) && ['line', 'area', 'area-stacked', 'histogram', 'scatter'].includes(type)) api.set('chart_type', 'bar');
}

/** The form's answers → a binding. */
export function bindingFrom(result, sources, kind, previous) {
    const src = sources.find((s) => s.id === result.bd_source) || sources[0];
    const plot = result.bd_plot || 'count';
    const binding = { source: src.id };
    const types = src.types().filter((t) => result[typeName(src, t.value)] === true).map((t) => t.value);
    if (types.length) binding.types = types;
    const f = result[`bd_filter_${src.id}`] || '';
    if (f.startsWith('key:')) binding.filter = { key: f.slice(4) };
    else if (f.startsWith('saved:')) {
        const saved = src.savedFilters().find((s) => s.id === f.slice(6));
        if (saved) binding.filter = { expr: JSON.parse(JSON.stringify(saved.expr)), label: saved.label };
    } else if (f === 'keep' && previous?.filter?.expr) binding.filter = previous.filter;
    if (isRows(kind)) {
        if (kind === 'list') {
            const sort = result[`bd_sort_${src.id}`];
            binding.sort = listSortsOf(src)[sort] ? sort : defaultSortOf(src);
            if (result.bd_open === false) binding.open = false;
        }
        return binding;
    }
    binding.plot = plot;
    if (kind !== 'kpi' && ['count', 'sum', 'avg'].includes(plot)) binding.field = result[`bd_field_${src.id}`];
    if (kind !== 'kpi' && plot === 'count' && result[`bd_split_${src.id}`]) binding.split = result[`bd_split_${src.id}`];
    if (NUMERIC_PLOTS.has(plot)) binding.valueField = result[`bd_value_${src.id}`];
    if (plot === 'burndown' && src.epics) {
        binding.unit = result.bd_unit === 'items' ? 'items' : 'points';
        if (result.bd_scope === 'epic' || result.bd_scope === 'project') {
            binding.scope = { kind: result.bd_scope, id: Number(result[`bd_${result.bd_scope}_${src.id}`]) };
        } else if (result.bd_scope === 'phase') binding.scope = { kind: 'phase', phase: result[`bd_phase_${src.id}`] };
        else binding.scope = { kind: 'all' };
    }
    if (plot === 'perWeek' || plot === 'burndown') {
        if (String(result.bd_from || '').trim()) binding.from = String(result.bd_from).trim();
        if (String(result.bd_to || '').trim()) binding.to = String(result.bd_to).trim();
    }
    return binding;
}

/**
 * Open the settings of one tile. Resolves to the new config, or null when the
 * dialog was cancelled.
 * @param {object} o
 * @param {'chart'|'kpi'|'list'|'people'} o.kind
 * @param {object[]} o.sources  available sources, built now
 * @param {string} [o.preferred]  the source a tile with no settings starts on
 */
export async function openTileSettings({ kind, config, schema, sources, preferred = null }) {
    const binding = config?.binding || null;
    // A tile over a store this page does not have (the Tracker switched off, by
    // you or for the machine; a store the project dropped) keeps its data
    // settings exactly as they are: offering only the stores that ARE here
    // would quietly turn a shared dashboard's tracker tile into a bugs one on
    // the next Save (STORY-0043). Only how it looks can be changed.
    const absent = !!binding?.source && !sources.some((s) => s.id === binding.source);
    const data = absent ? keptData(binding)
        : sources.length ? dataFields(sources, binding, kind, preferred) : { fields: [], defaults: {} };
    const display = displayFields(schema);
    const shown = new Map((schema?.fields || []).map((f) => [f.name, f.visibleWhen]));
    const fresh = !binding;
    const result = await openForm({
        title: 'Tile settings',
        fields: [...data.fields, ...display],
        defaults: { ...config, ...data.defaults },
        submitLabel: 'Save',
        onFieldChange: (name, _value, api) => {
            if (sources.length && !absent) {
                if (name === 'bd_plot' || (name === null && fresh)) suitChartType(api, api.get('bd_plot'));
                syncVisibility(api, sources, kind);
            }
            for (const [field, when] of shown) {
                if (when) api.setVisible(field, when.in.includes(api.get(when.field)));
            }
        },
    });
    if (!result) return null;
    const next = { ...config };
    for (const [k, v] of Object.entries(result)) if (!k.startsWith('bd_')) next[k] = v;
    if (absent) next.binding = binding;
    else if (sources.length) next.binding = bindingFrom(result, sources, kind, binding);
    return next;
}

/** The data part for a tile whose store is not here: what it reads, and why it cannot be changed now. */
function keptData(binding) {
    const label = binding.source === 'tracker' ? 'Tracker' : binding.source;
    return {
        fields: [
            { section: 'Data', name: 'bd_data' },
            { name: 'bd_source', label: 'Records', type: 'select',
                options: [{ value: binding.source, label: `${label} (not here now)` }],
                hint: `${check(null, binding).empty} Its data settings are kept as they are; you can still change how it looks.` },
        ],
        defaults: { bd_source: binding.source },
    };
}
