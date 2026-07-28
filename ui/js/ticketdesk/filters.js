/**
 * ticketdesk/filters.js — the BugDesk filter model.
 *
 * WHAT: a small, JSON-serialisable expression language over the mapped ticket
 * shape produced by data.js mapBug(), plus the store that persists user-authored
 * filters through the bridge.
 *
 *   Group  = { kind: 'group', op: 'AND' | 'OR', negate?: boolean, children: [...] }
 *   Clause = { kind: 'clause', field: string, op: string, value: any }
 *
 * Nesting is arbitrary depth; an EMPTY group matches everything (that is what
 * the builtin "All Bugs" filter is). Because the AST is plain JSON it round-trips
 * through the bridge, localStorage and the editor untouched.
 *
 * WHY an AST instead of the hand-written predicates that used to live in
 * pages.js QUEUE_FILTERS: the rail's eight filters were closures, so a user could
 * neither see nor copy them. Every one of those eight is re-expressed here as an
 * expression (BUILTIN_FILTERS), which makes "duplicate this builtin and tweak it"
 * a pure data operation — duplicateFilter() deep-clones the expr and the copy
 * behaves identically to the original.
 *
 * Persistence: GET/POST /api/filters (full-list replace) with localStorage under
 * 'bugdesk.filters' as an OFFLINE MIRROR — every successful load/save writes it,
 * and a failed bridge call falls back to it so a stale bridge (one without the
 * endpoints) still leaves the UI usable. The bridge failure is logged, never
 * silently swallowed.
 */

/* ── field catalogue ─────────────────────────────────────────────────
 *
 * One entry per comparable field of a mapped ticket. `get(t)` pulls the
 * COMPARABLE value, which is not always the display value: `status` reads the
 * raw machine status (open/investigation/testing/closed) rather than the
 * humanised label, `updated` reads t.sla (BugDesk has no SLA — that column
 * carries `updated`), and lastCommentAuthor collapses null to the sentinel
 * 'none' so "nobody has commented" is a selectable enum option. */

export const FILTER_FIELDS = [
    { key: 'id', label: 'Bug', type: 'text', get: (t) => t.id || '' },
    { key: 'pri', label: 'Priority', type: 'number', get: (t) => t.pri },
    {
        key: 'severity', label: 'Severity', type: 'enum',
        options: ['crash', 'high', 'medium', 'low'],
        get: (t) => t.severity || '',
    },
    {
        key: 'status', label: 'Status', type: 'enum',
        options: ['open', 'investigation', 'testing', 'closed'],
        get: (t) => t.rawStatus || '',
    },
    {
        key: 'type', label: 'Type', type: 'enum',
        options: ['BUG', 'REG', 'TASK'],
        get: (t) => t.type || '',
    },
    { key: 'summary', label: 'Summary', type: 'text', get: (t) => t.summary || '' },
    { key: 'subsystem', label: 'Subsystem', type: 'text', get: (t) => t.subsystem || '' },
    {
        key: 'assignee', label: 'Assignee', type: 'enum',
        options: ['norman', 'claude'],
        get: (t) => t.assignee || '',
    },
    { key: 'labels', label: 'Labels', type: 'set', get: (t) => Array.isArray(t.labels) ? t.labels : [] },
    { key: 'created', label: 'Created', type: 'date', get: (t) => t.created || '' },
    { key: 'updated', label: 'Updated', type: 'date', get: (t) => t.sla || '' },
    { key: 'comments', label: 'Comments', type: 'number', get: (t) => t.comments || 0 },
    {
        key: 'lastCommentAuthor', label: 'Last comment by', type: 'enum',
        options: ['norman', 'claude', 'none'],
        get: (t) => t.lastCommentAuthor || 'none',
    },
    { key: 'lastCommentDate', label: 'Last comment', type: 'date', get: (t) => t.lastCommentDate || '' },
];

const FIELD_BY_KEY = Object.fromEntries(FILTER_FIELDS.map((f) => [f.key, f]));

/* ── operators ───────────────────────────────────────────────────────
 *
 * arity is what the EDITOR renders: 0 = no value box, 1 = one box, 2 = two
 * (range). `multi: true` still has arity 1 but the value is an ARRAY, so the
 * editor renders a multi-select instead of a single input. */

const PRESENCE = [
    { id: 'is_empty', label: 'is empty', arity: 0 },
    { id: 'is_not_empty', label: 'is not empty', arity: 0 },
];

export const OPERATORS = {
    enum: [
        { id: 'is', label: 'is', arity: 1 },
        { id: 'is_not', label: 'is not', arity: 1 },
        { id: 'one_of', label: 'one of', arity: 1, multi: true },
        { id: 'none_of', label: 'none of', arity: 1, multi: true },
        ...PRESENCE,
    ],
    text: [
        { id: 'is', label: 'is', arity: 1 },
        { id: 'is_not', label: 'is not', arity: 1 },
        { id: 'contains', label: 'contains', arity: 1 },
        { id: 'not_contains', label: 'does not contain', arity: 1 },
        { id: 'starts_with', label: 'starts with', arity: 1 },
        { id: 'ends_with', label: 'ends with', arity: 1 },
        { id: 'one_of', label: 'one of', arity: 1, multi: true },
        { id: 'none_of', label: 'none of', arity: 1, multi: true },
        ...PRESENCE,
    ],
    number: [
        { id: 'is', label: 'is', arity: 1 },
        { id: 'is_not', label: 'is not', arity: 1 },
        { id: 'gt', label: '>', arity: 1 },
        { id: 'lt', label: '<', arity: 1 },
        { id: 'gte', label: '>=', arity: 1 },
        { id: 'lte', label: '<=', arity: 1 },
        { id: 'between', label: 'between', arity: 2 },
        { id: 'one_of', label: 'one of', arity: 1, multi: true },
        { id: 'none_of', label: 'none of', arity: 1, multi: true },
        ...PRESENCE,
    ],
    date: [
        { id: 'is', label: 'is', arity: 1 },
        { id: 'is_not', label: 'is not', arity: 1 },
        { id: 'before', label: 'before', arity: 1 },
        { id: 'after', label: 'after', arity: 1 },
        { id: 'between', label: 'between', arity: 2 },
        { id: 'in_last_days', label: 'in the last N days', arity: 1 },
        ...PRESENCE,
    ],
    set: [
        { id: 'contains', label: 'contains', arity: 1 },
        { id: 'not_contains', label: 'does not contain', arity: 1 },
        { id: 'one_of', label: 'one of', arity: 1, multi: true },
        { id: 'none_of', label: 'none of', arity: 1, multi: true },
        { id: 'all_of', label: 'all of', arity: 1, multi: true },
        ...PRESENCE,
    ],
};

const opDef = (type, id) => (OPERATORS[type] || []).find((o) => o.id === id);

/* ── value coercion ──────────────────────────────────────────────────
 *
 * Text/enum comparisons are case-insensitive (type codes are upper-case, enum
 * options lower-case, and users type whatever they type). Dates degrade to a
 * DAY number: every BugDesk date is 'YYYY-MM-DD' (comments may carry a time),
 * so slicing to the first 10 chars makes "is" mean "same day" without timezone
 * arithmetic. */

const low = (v) => String(v ?? '').trim().toLowerCase();
const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
const arr = (v) => (Array.isArray(v) ? v : v === '' || v === null || v === undefined ? [] : [v]);

/** 'YYYY-MM-DD[...]' → UTC ms at midnight, or NaN when unparseable. */
function day(v) {
    const s = String(v ?? '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
    return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
}
const todayUtc = () => {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const isBlank = (v) => v === null || v === undefined || v === '' ||
    (Array.isArray(v) && v.length === 0);

/* ── clause evaluation ───────────────────────────────────────────────
 *
 * Compiled per type so a clause does its type dispatch ONCE (at compile time)
 * instead of on every ticket — the queue re-runs a matcher over the whole store
 * on every keystroke of the editor's live preview. */

function compileClause(clause) {
    const field = FIELD_BY_KEY[clause?.field];
    if (!field) {
        console.warn('[bugdesk] filter clause references unknown field', clause?.field);
        return () => false;
    }
    const op = clause.op;
    const raw = clause.value;
    const get = field.get;

    // Presence operators are type-independent.
    if (op === 'is_empty') return (t) => isBlank(get(t));
    if (op === 'is_not_empty') return (t) => !isBlank(get(t));

    if (field.type === 'number') {
        const a = num(Array.isArray(raw) ? raw[0] : raw);
        const b = num(Array.isArray(raw) ? raw[1] : undefined);
        const set = arr(raw).map(num);
        switch (op) {
            case 'is': return (t) => num(get(t)) === a;
            case 'is_not': return (t) => num(get(t)) !== a;
            case 'gt': return (t) => num(get(t)) > a;
            case 'lt': return (t) => num(get(t)) < a;
            case 'gte': return (t) => num(get(t)) >= a;
            case 'lte': return (t) => num(get(t)) <= a;
            case 'between': return (t) => {
                const n = num(get(t));
                return n >= Math.min(a, b) && n <= Math.max(a, b);
            };
            case 'one_of': return (t) => set.includes(num(get(t)));
            case 'none_of': return (t) => !set.includes(num(get(t)));
        }
    }

    if (field.type === 'date') {
        const a = Array.isArray(raw) ? day(raw[0]) : day(raw);
        const b = Array.isArray(raw) ? day(raw[1]) : NaN;
        const days = num(Array.isArray(raw) ? raw[0] : raw);
        switch (op) {
            case 'is': return (t) => day(get(t)) === a;
            case 'is_not': return (t) => day(get(t)) !== a;
            case 'before': return (t) => { const d = day(get(t)); return !isNaN(d) && d < a; };
            case 'after': return (t) => { const d = day(get(t)); return !isNaN(d) && d > a; };
            case 'between': return (t) => {
                const d = day(get(t));
                return !isNaN(d) && d >= Math.min(a, b) && d <= Math.max(a, b);
            };
            // "in the last N days" is inclusive of today and of the Nth day back.
            case 'in_last_days': return (t) => {
                const d = day(get(t));
                if (isNaN(d) || isNaN(days)) return false;
                return d >= todayUtc() - (days - 1) * 86400000 && d <= todayUtc();
            };
        }
    }

    if (field.type === 'set') {
        const one = low(Array.isArray(raw) ? raw[0] : raw);
        const many = arr(raw).map(low).filter(Boolean);
        const vals = (t) => arr(get(t)).map(low);
        switch (op) {
            case 'contains': return (t) => vals(t).includes(one);
            case 'not_contains': return (t) => !vals(t).includes(one);
            case 'one_of': return (t) => { const v = vals(t); return many.some((m) => v.includes(m)); };
            case 'none_of': return (t) => { const v = vals(t); return !many.some((m) => v.includes(m)); };
            case 'all_of': return (t) => { const v = vals(t); return many.every((m) => v.includes(m)); };
        }
    }

    // enum + text share string semantics; enum simply constrains the options
    // the editor offers, it does not change how a comparison behaves.
    const one = low(Array.isArray(raw) ? raw[0] : raw);
    const many = arr(raw).map(low).filter((s) => s !== '');
    switch (op) {
        case 'is': return (t) => low(get(t)) === one;
        case 'is_not': return (t) => low(get(t)) !== one;
        case 'contains': return (t) => low(get(t)).includes(one);
        case 'not_contains': return (t) => !low(get(t)).includes(one);
        case 'starts_with': return (t) => low(get(t)).startsWith(one);
        case 'ends_with': return (t) => low(get(t)).endsWith(one);
        case 'one_of': return (t) => many.includes(low(get(t)));
        case 'none_of': return (t) => !many.includes(low(get(t)));
    }

    console.warn('[bugdesk] filter clause uses unknown operator', op, 'for', field.key);
    return () => false;
}

function compile(node) {
    if (!node) return () => true;
    if (node.kind === 'clause') return compileClause(node);

    const children = (Array.isArray(node.children) ? node.children : []).map(compile);
    const negate = !!node.negate;
    if (!children.length) return negate ? () => false : () => true; // empty group = everything
    const or = String(node.op || 'AND').toUpperCase() === 'OR';
    const test = or
        ? (t) => children.some((c) => c(t))
        : (t) => children.every((c) => c(t));
    return negate ? (t) => !test(t) : test;
}

/** Evaluate an expression against one mapped ticket. */
export function evaluateFilter(expr, ticket) {
    return matcherFor(expr)(ticket);
}

/* Compiled matchers are cached by the expression's JSON so the queue can call
 * matcherFor() once per render (or per ticket, it does not matter) without
 * recompiling. The cache is bounded: the editor mutates the draft expression on
 * every keystroke, which would otherwise grow it without limit. */
const _matcherCache = new Map();
const MATCHER_CACHE_MAX = 200;

/** Compile an expression into a reusable predicate. */
export function matcherFor(expr) {
    let key;
    try {
        key = JSON.stringify(expr);
    } catch {
        return compile(expr); // cyclic draft from the editor — compile uncached
    }
    const hit = _matcherCache.get(key);
    if (hit) return hit;
    const fn = compile(expr);
    if (_matcherCache.size >= MATCHER_CACHE_MAX) _matcherCache.clear();
    _matcherCache.set(key, fn);
    return fn;
}

/* ── description ─────────────────────────────────────────────────────
 *
 * Renders the sentence shown on the rail and in the editor header, e.g.
 * "Status is investigation AND Severity one of crash, high". Nested groups get
 * parentheses so precedence is never ambiguous. */

function describeValue(op, value) {
    if (!op || op.arity === 0) return '';
    if (op.multi) return arr(value).join(', ');
    if (op.arity === 2) {
        const [a, b] = arr(value);
        return `${a ?? ''} and ${b ?? ''}`;
    }
    return String(Array.isArray(value) ? value[0] ?? '' : value ?? '');
}

function describeNode(node, depth) {
    if (!node) return '';
    if (node.kind === 'clause') {
        const field = FIELD_BY_KEY[node.field];
        const op = field && opDef(field.type, node.op);
        const label = field ? field.label : node.field;
        if (!op) return `${label} ${node.op}`.trim();
        const val = describeValue(op, node.value);
        return val ? `${label} ${op.label} ${val}` : `${label} ${op.label}`;
    }
    const children = (Array.isArray(node.children) ? node.children : [])
        .map((c) => describeNode(c, depth + 1)).filter(Boolean);
    if (!children.length) return node.negate ? 'nothing' : 'everything';
    const joined = children.join(String(node.op || 'AND').toUpperCase() === 'OR' ? ' OR ' : ' AND ');
    if (node.negate) return `NOT (${joined})`;
    return depth > 0 && children.length > 1 ? `(${joined})` : joined;
}

/** Human sentence for an expression. */
export function describeFilter(expr) {
    return describeNode(expr, 0);
}

/* ── validation ──────────────────────────────────────────────────────
 *
 * Returns EVERY problem, not the first, so the editor can mark each broken
 * clause at once. Messages name the field so they read on their own. */

function validateNode(node, errors, path) {
    if (!node || typeof node !== 'object') {
        errors.push(`${path}: not an expression node`);
        return;
    }
    if (node.kind === 'group') {
        if (node.op !== 'AND' && node.op !== 'OR') errors.push(`${path}: group op must be AND or OR`);
        if (!Array.isArray(node.children)) { errors.push(`${path}: group children must be an array`); return; }
        node.children.forEach((c, i) => validateNode(c, errors, `${path}/${i}`));
        return;
    }
    if (node.kind !== 'clause') { errors.push(`${path}: unknown node kind "${node.kind}"`); return; }

    const field = FIELD_BY_KEY[node.field];
    if (!field) { errors.push(`${path}: unknown field "${node.field}"`); return; }
    const op = opDef(field.type, node.op);
    if (!op) { errors.push(`${field.label}: "${node.op}" is not a valid operator`); return; }

    if (op.arity === 0) return;
    if (op.multi) {
        if (!Array.isArray(node.value) || node.value.length === 0)
            errors.push(`${field.label} ${op.label}: pick at least one value`);
        return;
    }
    if (op.arity === 2) {
        const v = arr(node.value);
        if (v.length < 2 || isBlank(v[0]) || isBlank(v[1]))
            errors.push(`${field.label} ${op.label}: needs two values`);
        return;
    }
    if (isBlank(Array.isArray(node.value) ? node.value[0] : node.value)) {
        errors.push(`${field.label} ${op.label}: needs a value`);
        return;
    }
    if (field.type === 'number' && isNaN(num(Array.isArray(node.value) ? node.value[0] : node.value)))
        errors.push(`${field.label} ${op.label}: value must be a number`);
    if (field.type === 'date' && op.id !== 'in_last_days' &&
        isNaN(day(Array.isArray(node.value) ? node.value[0] : node.value)))
        errors.push(`${field.label} ${op.label}: value must be a date (YYYY-MM-DD)`);
    if (field.type === 'date' && op.id === 'in_last_days' &&
        !(num(Array.isArray(node.value) ? node.value[0] : node.value) > 0))
        errors.push(`${field.label} ${op.label}: value must be a positive number of days`);
}

/** { ok, errors } — an empty group is valid (it matches everything). */
export function validateFilter(expr) {
    const errors = [];
    validateNode(expr, errors, 'expr');
    return { ok: errors.length === 0, errors };
}

/** A fresh, empty AND group — matches everything until clauses are added. */
export function emptyExpr() {
    return { kind: 'group', op: 'AND', children: [] };
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/* ── builtin filters ─────────────────────────────────────────────────
 *
 * The eight filters that used to be closures in pages.js QUEUE_FILTERS, in the
 * SAME order (that is the rail order) and with identical semantics, so
 * duplicating one produces a custom filter that matches exactly the same rows.
 * `key` is what routing props carry (props.filter), and getFilter() resolves
 * builtin keys as well as custom ids. */

export const BUILTIN_FILTERS = [
    {
        key: 'needs-reply', label: 'Needs my reply', icon: 'mark_chat_unread', builtin: true,
        expr: {
            kind: 'group', op: 'AND', children: [
                { kind: 'clause', field: 'lastCommentAuthor', op: 'is', value: 'claude' },
                { kind: 'clause', field: 'status', op: 'is_not', value: 'closed' },
            ],
        },
    },
    // The DEFAULT view (see DEFAULT_FILTER in pages.js). A closed bug is done
    // with — it should not be in the way of the queue you actually work from.
    // "All Bugs" below still means all, closed included.
    {
        key: 'active', label: 'Active', icon: 'pending', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'status', op: 'is_not', value: 'closed' }] },
    },
    { key: 'all', label: 'All Bugs', icon: 'inbox', builtin: true, expr: emptyExpr() },
    {
        key: 'open', label: 'Open', icon: 'fiber_new', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'status', op: 'is', value: 'open' }] },
    },
    {
        key: 'investigation', label: 'Investigation', icon: 'science', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'status', op: 'is', value: 'investigation' }] },
    },
    {
        key: 'testing', label: 'Testing', icon: 'bug_report', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'status', op: 'is', value: 'testing' }] },
    },
    {
        key: 'closed', label: 'Closed', icon: 'check_circle', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'status', op: 'is', value: 'closed' }] },
    },
    {
        key: 'on-me', label: 'On me', icon: 'person', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'assignee', op: 'is', value: 'norman' }] },
    },
    {
        key: 'on-claude', label: 'On Claude', icon: 'smart_toy', builtin: true,
        expr: { kind: 'group', op: 'AND', children: [{ kind: 'clause', field: 'assignee', op: 'is', value: 'claude' }] },
    },
];

/* ── icon palette ────────────────────────────────────────────────────
 * Curated Material Symbols (outlined) names — the editor's icon dropdown.
 * Deliberately a shortlist: the full set is thousands of names and a filter
 * only ever wants "a small glyph that reads at 14px in the rail". */

export const FILTER_ICONS = [
    'inbox', 'filter_alt', 'bug_report', 'science', 'fiber_new', 'check_circle',
    'mark_chat_unread', 'forum', 'person', 'group', 'smart_toy', 'engineering',
    'flag', 'star', 'bolt', 'priority_high', 'warning', 'error', 'report',
    'schedule', 'timer', 'hourglass_empty', 'event', 'calendar_month', 'history',
    'label', 'sell', 'bookmark', 'push_pin', 'folder', 'storage', 'category',
    'task_alt', 'checklist', 'done_all', 'pending', 'block', 'visibility',
    'trending_up', 'trending_down', 'whatshot', 'ac_unit', 'build', 'construction',
    'terminal', 'code', 'memory', 'rocket_launch', 'favorite', 'help',
];

/* ── custom filter store ─────────────────────────────────────────────
 *
 * The bridge holds the authoritative list (GET/POST /api/filters, full replace);
 * localStorage['bugdesk.filters'] mirrors it. Reads prefer the bridge and fall
 * back to the mirror; writes always update the mirror, then push the whole list.
 * A push against an OLD bridge (no /api/filters route → the permissive catch-all
 * answers {ok:true,result:{...}} without `filters`) is reported to the console
 * and the local state stands: the alternative is losing the user's edit.
 *
 * CustomFilter = { id, label, icon, expr, builtin: false } */

const STORAGE_KEY = 'bugdesk.filters';

let _filters = [];
const _subs = new Set();

function notify() {
    for (const cb of Array.from(_subs)) {
        try { cb(_filters); } catch (err) { console.warn('[bugdesk] filters subscriber failed', err); }
    }
}

function normalize(f, i) {
    return {
        id: String(f?.id || `f${Date.now().toString(36)}${i}`),
        label: String(f?.label || 'Untitled filter'),
        icon: String(f?.icon || 'filter_alt'),
        expr: f?.expr && typeof f.expr === 'object' ? f.expr : emptyExpr(),
        builtin: false,
    };
}
const normalizeAll = (list) => (Array.isArray(list) ? list.map(normalize) : []);

function readMirror() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
        return normalizeAll(JSON.parse(raw));
    } catch (err) {
        // Corrupt mirror: report it and start clean rather than wedging the UI.
        console.warn('[bugdesk] discarding unreadable filter mirror', err);
        localStorage.removeItem(STORAGE_KEY);
        return [];
    }
}
const writeMirror = (list) => localStorage.setItem(STORAGE_KEY, JSON.stringify(list));

/** Fetch the custom filters from the bridge (mirror on failure) and populate
 *  the live store. Safe to call repeatedly — it always ends with a notify(). */
export async function loadFilters() {
    try {
        const res = await fetch('/api/filters', { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`GET /api/filters → ${res.status}`);
        const j = await res.json();
        if (!Array.isArray(j.filters)) throw new Error('bridge returned no filters array');
        _filters = normalizeAll(j.filters);
        writeMirror(_filters);
    } catch (err) {
        console.warn('[bugdesk] filter bridge unavailable, using local mirror:', err.message);
        _filters = readMirror();
    }
    notify();
    return _filters;
}

/** The live array — current contents, no fetch. */
export function listFilters() {
    return _filters;
}

/** Resolve a custom filter id OR a builtin key. */
export function getFilter(id) {
    if (!id) return undefined;
    return BUILTIN_FILTERS.find((b) => b.key === id) || _filters.find((f) => f.id === id);
}

const newId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Push the whole list to the bridge; the mirror is written first so an offline
 *  save still survives a reload. */
async function persist() {
    writeMirror(_filters);
    try {
        const res = await fetch('/api/filters', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ filters: _filters }),
        });
        if (!res.ok) throw new Error(`POST /api/filters → ${res.status}`);
        const j = await res.json();
        if (!Array.isArray(j.filters)) throw new Error('bridge returned no filters array');
        _filters = normalizeAll(j.filters);
        writeMirror(_filters);
    } catch (err) {
        console.warn('[bugdesk] filters not persisted to the bridge (local mirror kept):', err.message);
    }
}

/** Create (falsy id) or update a custom filter; returns the stored record. */
export async function saveFilter(filter) {
    const id = filter?.id || newId();
    const rec = normalize({ ...filter, id }, 0);
    const at = _filters.findIndex((f) => f.id === id);
    if (at >= 0) _filters[at] = rec; else _filters.push(rec);
    await persist();
    notify();
    return getFilter(id) || rec;
}

/** Remove a custom filter (builtin keys are not deletable and are ignored). */
export async function deleteFilter(id) {
    const at = _filters.findIndex((f) => f.id === id);
    if (at < 0) return;
    _filters.splice(at, 1);
    await persist();
    notify();
}

/** In-memory draft copy of a builtin OR a custom filter: deep-cloned expr,
 *  " (copy)" label, NO id — nothing is persisted until saveFilter() is called.
 *  This is the "copy a builtin into a custom one" path. */
export function duplicateFilter(keyOrId) {
    const src = getFilter(keyOrId);
    if (!src) return undefined;
    return {
        id: '',
        label: `${src.label} (copy)`,
        icon: src.icon || 'filter_alt',
        expr: clone(src.expr || emptyExpr()),
        builtin: false,
    };
}

/** Subscribe to store changes; returns the unsubscribe function. */
export function onFiltersChanged(cb) {
    _subs.add(cb);
    return () => _subs.delete(cb);
}
