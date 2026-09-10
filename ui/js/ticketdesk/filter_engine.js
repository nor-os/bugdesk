/**
 * ticketdesk/filter_engine.js — the filter expression language, with no idea
 * what it is filtering.
 *
 *   Group  = { kind: 'group', op: 'AND' | 'OR', negate?: boolean, children: [...] }
 *   Clause = { kind: 'clause', field: string, op: string, value: any }
 *
 * Nesting is arbitrary depth; an EMPTY group matches everything. Because the AST
 * is plain JSON it round-trips through the bridge, localStorage and the editor
 * untouched.
 *
 * WHY THIS IS SEPARATE FROM ./filters.js. All of this used to live there,
 * hard-wired to the bug queue's field catalogue. The backlog needs the same
 * language over a completely different set of fields — type, phase, owning
 * epic, acceptance-criteria counts — and the alternative to extracting the
 * engine was a second copy of the compiler, the describer and the validator
 * that would drift from this one the first time either was fixed.
 *
 * So: a FIELD CATALOGUE goes in, a bound MODEL comes out.
 *
 *   const model = createFilterModel({ fields: [...] });
 *   model.matcherFor(expr)(row);
 *   model.describeFilter(expr);   // "Status is investigation AND Severity one of crash, high"
 *
 * A field is `{ key, label, type, get(row), options? }`, where `get` pulls the
 * COMPARABLE value — not always the displayed one (a bug's `status` compares the
 * raw machine status, never the humanised label).
 */

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

export const opDef = (type, id) => (OPERATORS[type] || []).find((o) => o.id === id);

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
    'workspaces', 'article', 'account_tree', 'lan', 'pending_actions',
    'rate_review', 'timeline', 'flag_circle', 'stacks',
];

/** A fresh, empty AND group — matches everything until clauses are added. */
export const emptyExpr = () => ({ kind: 'group', op: 'AND', children: [] });

export const cloneExpr = (v) => JSON.parse(JSON.stringify(v));

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

/**
 * Enum options may be plain strings or {value|id,label} — both are legal in a
 * field catalogue, and `options` may be a GETTER so a vocabulary that only
 * exists once data has loaded (a backlog's phases) stays live.
 */
export const optionValues = (def) => (def?.options || [])
    .map((o) => (typeof o === 'string' ? o : (o.value ?? o.id ?? '')))
    .filter(Boolean);

/* ── the model ───────────────────────────────────────────────────── */

let _modelSeq = 0;

/**
 * Bind a field catalogue into everything that needs to know about it.
 *
 * @param {object}  o
 * @param {Array}   o.fields  `{ key, label, type, get(row), options? }[]`
 * @param {string}  [o.noun]  what one row is called, for messages ("bug", "item")
 */
export function createFilterModel({ fields, noun = 'row' }) {
    const id = ++_modelSeq;
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    const fieldByKey = (key) => byKey[key] || null;

    /* Compiled per type so a clause does its type dispatch ONCE (at compile
     * time) instead of on every row — the queue re-runs a matcher over the whole
     * store on every keystroke of the editor's live preview. */
    function compileClause(clause) {
        const field = byKey[clause?.field];
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

    /* Compiled matchers are cached by the expression's JSON so a page can call
     * matcherFor() once per render (or per row, it does not matter) without
     * recompiling. The cache is bounded: the editor mutates the draft expression
     * on every keystroke, which would otherwise grow it without limit. The model
     * id is part of the key — two models can hold the same expression JSON and
     * must NOT share a compiled matcher, since `field.get` differs. */
    const _cache = new Map();
    const CACHE_MAX = 200;

    function matcherFor(expr) {
        let key;
        try {
            key = `${id}:${JSON.stringify(expr)}`;
        } catch {
            return compile(expr); // cyclic draft from the editor — compile uncached
        }
        const hit = _cache.get(key);
        if (hit) return hit;
        const fn = compile(expr);
        if (_cache.size >= CACHE_MAX) _cache.clear();
        _cache.set(key, fn);
        return fn;
    }

    /* ── description ─────────────────────────────────────────────────
     * "Status is investigation AND Severity one of crash, high". Nested groups
     * get parentheses so precedence is never ambiguous. */

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
            const field = byKey[node.field];
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

    const describeFilter = (expr) => describeNode(expr, 0);

    /* ── validation ──────────────────────────────────────────────────
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

        const field = byKey[node.field];
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
    function validateFilter(expr) {
        const errors = [];
        validateNode(expr, errors, 'expr');
        return { ok: errors.length === 0, errors };
    }

    /** Evaluate an expression against one row. */
    const evaluateFilter = (expr, row) => matcherFor(expr)(row);

    return Object.freeze({
        id, fields, noun, fieldByKey,
        matcherFor, describeFilter, validateFilter, evaluateFilter,
        emptyExpr, cloneExpr,
    });
}
