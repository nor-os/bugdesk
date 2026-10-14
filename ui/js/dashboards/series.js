/**
 * series.js — records into the numbers a dashboard tile draws (STORY-0036).
 *
 * Pure: no imports, no DOM, no store. Every function takes the rows and a way
 * to read a field (`field.get(row)`, or a raw reader for custom fields, whose
 * value is the string in the file), so the same code serves the bug store and
 * the backlog, and the tests can hand it plain objects.
 *
 * NUMBERS ARE STRICT. A points value of `M` or `?` is an estimate nobody could
 * give, not a zero: `toNumber` refuses it, and every numeric aggregate counts
 * what it left out (`skipped`) so the tile can say so in its note. An empty
 * value is "not estimated" and is left out without a note.
 */

const NUM_RE = /^\s*-?\d+(\.\d+)?\s*$/;

/** A finite number, or null. Numbers pass; strings must look like one. */
export function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && NUM_RE.test(v)) return Number(v);
    return null;
}

/** Two decimals at most: a sum of 0.1 + 0.2 points is 0.3. */
const round = (n) => Math.round(n * 100) / 100;

const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** `YYYY-MM-DD` of a date or a stamp ("2026-09-13 16:05"), or ''. */
export const dayOf = (v) => {
    const m = /^\d{4}-\d{2}-\d{2}/.exec(String(v ?? '').trim());
    return m ? m[0] : '';
};

/** The values of a field over rows as numbers, plus how many were not numbers. */
export function numericValues(rows, read) {
    const values = [];
    let skipped = 0;
    for (const r of rows) {
        const raw = read(r);
        if (blank(raw)) continue;
        const n = toNumber(raw);
        if (n === null) skipped++;
        else values.push(n);
    }
    return { values, skipped };
}

/**
 * The key a row is grouped under for a field. Sets (labels) give one key per
 * member; dates group by month; everything else by its value. '' is "none".
 */
export function groupKeys(field, value) {
    if (field.type === 'set') {
        const list = Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];
        return list.length ? [...new Set(list)] : [''];
    }
    if (blank(value)) return [''];
    if (field.type === 'date') return [dayOf(value).slice(0, 7) || String(value)];
    if (field.type === 'number') { const n = toNumber(value); return [n === null ? String(value) : n]; }
    return [String(value)];
}

const optionValue = (o) => (o && typeof o === 'object' ? o.value : o);

/** Group order: the field's own option order where it has one, then by count. */
function orderKeys(field, counts) {
    const opts = (Array.isArray(field.options) ? field.options : []).map(optionValue);
    return [...counts.keys()].sort((a, b) => {
        if (a === '' || b === '') return a === '' ? 1 : -1;            // "none" last
        if (field.type === 'number' && typeof a === 'number' && typeof b === 'number') return a - b;
        if (field.type === 'date') return String(a).localeCompare(String(b));
        const ia = opts.indexOf(a), ib = opts.indexOf(b);
        if (ia >= 0 || ib >= 0) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
        return (counts.get(b) - counts.get(a)) || String(a).localeCompare(String(b));
    });
}

/** The display text of a group key. */
export function keyLabel(field, key) {
    if (key === '' || key === null || key === undefined) return '(none)';
    const opt = (Array.isArray(field.options) ? field.options : [])
        .find((o) => o && typeof o === 'object' && o.value === key);
    return opt?.label ? String(opt.label) : String(key);
}

/** Rows per group of `field`. → `{x: labels, keys, y: counts}` */
export function groupCount(rows, field) {
    const counts = new Map();
    for (const r of rows) {
        for (const k of groupKeys(field, field.get(r))) counts.set(k, (counts.get(k) || 0) + 1);
    }
    const keys = orderKeys(field, counts);
    return { x: keys.map((k) => keyLabel(field, k)), keys, y: keys.map((k) => counts.get(k)) };
}

/**
 * Rows per group of `field`, one series per value of `split` (STORY-0038).
 * → `{x: labels, keys, series: [{key, y: counts}]}`
 */
export function groupCountSplit(rows, field, split) {
    const counts = new Map();       // group key → count, for the group order
    const splits = new Map();       // split key → count, for the series order
    const cell = new Map();         // group key → split key → count
    for (const r of rows) {
        const sks = groupKeys(split, split.get(r));
        for (const k of groupKeys(field, field.get(r))) {
            counts.set(k, (counts.get(k) || 0) + 1);
            const row = cell.get(k) || cell.set(k, new Map()).get(k);
            for (const sk of sks) {
                row.set(sk, (row.get(sk) || 0) + 1);
                splits.set(sk, (splits.get(sk) || 0) + 1);
            }
        }
    }
    const keys = orderKeys(field, counts);
    return {
        x: keys.map((k) => keyLabel(field, k)),
        keys,
        series: orderKeys(split, splits).map((sk) => ({ key: sk, y: keys.map((k) => cell.get(k).get(sk) || 0) })),
    };
}

/**
 * Sum or average of a numeric field per group of `field`. A group with no
 * numeric value at all has no average and is left out.
 * → `{x, keys, y, skipped}`
 */
export function aggregate(rows, field, readValue, op) {
    const groups = new Map();
    let skipped = 0;
    for (const r of rows) {
        const raw = readValue(r);
        if (blank(raw)) continue;
        const n = toNumber(raw);
        if (n === null) { skipped++; continue; }
        for (const k of groupKeys(field, field.get(r))) {
            const g = groups.get(k) || { sum: 0, n: 0 };
            g.sum += n; g.n++;
            groups.set(k, g);
        }
    }
    const counts = new Map([...groups].map(([k, g]) => [k, g.n]));
    const keys = orderKeys(field, counts);
    const y = keys.map((k) => round(op === 'avg' ? groups.get(k).sum / groups.get(k).n : groups.get(k).sum));
    return { x: keys.map((k) => keyLabel(field, k)), keys, y, skipped };
}

/** One number over all rows: a count, or a sum / average of a numeric field. */
export function kpi(rows, op, readValue = null) {
    if (op !== 'sum' && op !== 'avg') return { value: rows.length, skipped: 0 };
    const { values, skipped } = numericValues(rows, readValue);
    if (!values.length) return { value: op === 'sum' ? 0 : null, skipped };
    const sum = values.reduce((a, b) => a + b, 0);
    return { value: round(op === 'avg' ? sum / values.length : sum), skipped };
}


/** "3 non-numeric values (like M or ?) left out", or ''. */
export function skippedNote(skipped, label = 'value') {
    if (!skipped) return '';
    return `${skipped} non-numeric ${label}${skipped === 1 ? '' : 's'} (like M or ?) left out`;
}

/* ── over time ─────────────────────────────────────────────────── */

const DAY = 86400000;
const toDate = (day) => new Date(`${day}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);

/** The Monday of a day's week, as `YYYY-MM-DD` (UTC calendar). */
export function weekStart(day) {
    const d = toDate(day);
    return iso(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY));
}

export const addDays = (day, n) => iso(new Date(toDate(day).getTime() + n * DAY));

/**
 * The day a finished row was finished: its last move from an unfinished status
 * into a finished one in History, or — no such line, e.g. a hand edit — the day
 * it was last updated.
 *
 * @param {Array<{date, from, to}>} history  the row's status changes, oldest first
 * @param {(status:string)=>boolean} isFinished
 */
export function finishedDay(history, isFinished, updated) {
    let day = '';
    for (const e of Array.isArray(history) ? history : []) {
        if (isFinished(e.to) && !isFinished(e.from)) day = dayOf(e.date) || day;
    }
    return day || dayOf(updated);
}

/**
 * Rows created and finished per week from `from` to `to` (inclusive days).
 * @param {object} acc  `{created(r), finished(r) → day or ''}`
 * → `{x: weekStarts, created: n[], finished: n[]}`
 */
export function perWeek(rows, acc, { from, to }) {
    const first = weekStart(from), last = weekStart(to);
    const x = [];
    for (let w = first; w <= last; w = addDays(w, 7)) x.push(w);
    const index = new Map(x.map((w, i) => [w, i]));
    const created = x.map(() => 0), finished = x.map(() => 0);
    const put = (arr, day) => {
        if (!day || day < from || day > to) return;
        const i = index.get(weekStart(day));
        if (i !== undefined) arr[i]++;
    };
    for (const r of rows) {
        put(created, dayOf(acc.created(r)));
        put(finished, acc.finished(r));
    }
    return { x, created, finished };
}

/* ── burndown (STORY-0037) ─────────────────────────────────────── */

/**
 * A record's status on `day`, replayed from its History status lines.
 *
 * - With lines: the first line's `from` until its day (`(unset)` reads as '',
 *   which no category calls finished), then each line's `to` from its day on.
 *   If the status now differs from the last line's `to` (a hand edit), the
 *   status now holds from the later of that line's day and `updated`.
 * - Without lines: the status now since `created` — except a finished (or
 *   dropped) record, which is unfinished ('') until `updated`.
 *
 * @param {Array<{date, from, to}>} history  oldest first
 * @param {string} now          the status in the file
 * @param {string} updatedDay   YYYY-MM-DD
 * @param {boolean} doneNow     whether `now` is finished or dropped
 */
export function statusAt(history, day, now, updatedDay, doneNow) {
    const lines = (Array.isArray(history) ? history : []).filter((e) => dayOf(e?.date));
    if (!lines.length) return doneNow && updatedDay && day < updatedDay ? '' : now;
    let s = lines[0].from || '';
    for (const e of lines) if (dayOf(e.date) <= day) s = e.to || '';
    const last = lines[lines.length - 1];
    if ((last.to || '') !== now) {
        const from = [dayOf(last.date), updatedDay].sort().at(-1);
        if (day >= from) s = now;
    }
    return s;
}

/**
 * Remaining work per day from `from` to `to`.
 *
 * Each row counts from its created day. On a day its replayed status is
 * `dropped` it is out of the scope (it does not burn down: the Scope line falls
 * with it); in any other finished-category status it is burned down; otherwise
 * it is remaining. Days after `today` are null, so the lines stop at today.
 *
 * @param {object} acc  `{created(r), updated(r), status(r), history(r), finished(r, status), weight(r) → number|null}`
 * → `{x, remaining, scope, ideal: {x, y}, today: day|null, skipped}`
 */
export function burndown(rows, acc, { from, to, today }) {
    const x = [];
    for (let d = from; d <= to; d = addDays(d, 1)) x.push(d);
    let skipped = 0;
    const recs = rows.map((r) => {
        const w = acc.weight(r);
        if (w === null) skipped++;
        const now = acc.status(r);
        return {
            r, w: w ?? 0, now,
            created: dayOf(acc.created(r)), updated: dayOf(acc.updated(r)), history: acc.history(r),
            doneNow: now === 'dropped' || acc.finished(r, now),
        };
    });
    const remaining = [], scope = [];
    for (const d of x) {
        let rem = 0, all = 0;
        for (const c of recs) {
            if (!c.created || c.created > d) continue;
            const s = statusAt(c.history, d, c.now, c.updated, c.doneNow);
            if (s === 'dropped') continue;
            all += c.w;
            if (!acc.finished(c.r, s)) rem += c.w;
        }
        remaining.push(round(rem));
        scope.push(round(all));
    }
    const start = remaining[0] ?? 0;
    const past = (i) => x[i] > today;
    return {
        x,
        remaining: remaining.map((v, i) => (past(i) ? null : v)),
        scope: scope.map((v, i) => (past(i) ? null : v)),
        ideal: { x: [from, to], y: [start, 0] },
        today: today >= from && today <= to ? today : null,
        skipped,
    };
}

/* ── click-through ─────────────────────────────────────────────── */

/**
 * The filter clause that selects one group's rows, in the list views' filter
 * language — or null when the key cannot be expressed (a number field's
 * non-numeric value).
 */
export function drillClause(field, key) {
    const clause = (op, value) => ({ kind: 'clause', field: field.key, op, value });
    if (key === '' || key === null || key === undefined) return clause('is_empty', '');
    if (field.type === 'set') return clause('contains', key);
    if (field.type === 'number') return typeof key === 'number' ? clause('is', key) : null;
    if (field.type === 'date') {
        const [y, m] = String(key).split('-').map(Number);
        if (!y || !m) return null;
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        return clause('between', [`${key}-01`, `${key}-${String(last).padStart(2, '0')}`]);
    }
    return clause('is', key);
}

/** AND of the given parts, nested groups flattened, empty parts dropped. */
export function andExpr(...parts) {
    const children = [];
    for (const p of parts) {
        if (!p) continue;
        if (p.kind === 'group' && p.op === 'AND' && !p.negate) children.push(...(p.children || []));
        else children.push(p);
    }
    return { kind: 'group', op: 'AND', children };
}
