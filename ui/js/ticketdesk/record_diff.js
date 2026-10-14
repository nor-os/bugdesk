/**
 * ticketdesk/record_diff.js — what changed in a record, said the way the record
 * is read rather than the way git stores it.
 *
 * A record file is front matter (one `key: value` per field) and a markdown
 * body. `git diff` shows an edit to either as a pair of YAML lines inside a
 * hunk with four lines of headers above it; the Changes pane shows the two
 * halves separately instead:
 *
 *   FIELDS  each front-matter key whose value differs: Severity high → critical
 *   TEXT    the body, line by line, numbered as in the file, without git's
 *           `diff --git` / `index` / `---` / `+++` lines
 *
 * Both are worked out from the committed and the current text of the file
 * (GET /api/git/diff returns both), so nothing here depends on git's output.
 */

/**
 * Split a record into its front matter (ordered `[key, value]` pairs, a value
 * spanning continuation lines kept whole) and its body.
 * @param {string} text
 * @returns {{ fields: Map<string,string>, body: string[], bodyStart: number }}
 *   `bodyStart` is the 1-based file line the body's first line sits on.
 */
export function splitRecord(text) {
    const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
    const fields = new Map();
    if (lines[0]?.trim() !== '---') return { fields, body: text ? lines : [], bodyStart: 1 };
    let i = 1;
    let key = null;
    for (; i < lines.length && lines[i].trim() !== '---'; i++) {
        const line = lines[i];
        const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
        if (m && !/^\s/.test(line)) { key = m[1]; fields.set(key, m[2]); continue; }
        // A list item or an indented continuation belongs to the key above it.
        if (key !== null) fields.set(key, `${fields.get(key)}\n${line}`.replace(/^\n/, ''));
    }
    return { fields, body: lines.slice(i + 1), bodyStart: i + 2 };
}

/** `"Export to CSV"` → `Export to CSV`; an empty value reads as a dash. */
function show(value) {
    const v = String(value ?? '').trim();
    const unq = v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0] ? v.slice(1, -1) : v;
    return unq.length ? unq : '—';
}

/** `severity` → `Severity`, `dueDate` / `due_date` → `Due date`. */
export function fieldLabel(key) {
    const words = String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The front-matter fields that differ, in the order the new file has them
 * (removed ones last).
 * @returns {Array<{key:string, name:string, from:string, to:string}>}
 */
export function fieldChanges(before, after) {
    const a = splitRecord(before).fields;
    const b = splitRecord(after).fields;
    const out = [];
    for (const [key, to] of b) if (a.get(key) !== to) out.push({ key, name: fieldLabel(key), from: show(a.get(key)), to: show(to) });
    for (const [key, from] of a) if (!b.has(key)) out.push({ key, name: fieldLabel(key), from: show(from), to: '—' });
    return out;
}

/** Past this many lines a side, the line diff is not attempted (the pane offers Raw git). */
export const TEXT_DIFF_LIMIT = 1500;

/**
 * The body's changes as display lines with `context` unchanged lines around
 * each change. `n` is the line number in the CURRENT file ('' for a removed
 * line); a gap between hunks is one `{ gap: true }` line.
 * @returns {Array<{n:string, sign:''|'+'|'-', text:string, gap?:boolean}>|null}
 *   [] when the body did not change, null when it is too long to diff here.
 */
export function textChanges(before, after, context = 3) {
    const A = splitRecord(before);
    const B = splitRecord(after);
    const a = A.body;
    const b = B.body;
    if (a.length > TEXT_DIFF_LIMIT || b.length > TEXT_DIFF_LIMIT) return null;
    // Longest common subsequence, then walked forwards into an edit script.
    const n = a.length;
    const m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) { ops.push({ sign: '', text: b[j], nb: j }); i++; j++; }
        else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { ops.push({ sign: '+', text: b[j], nb: j }); j++; }
        else { ops.push({ sign: '-', text: a[i], nb: -1 }); i++; }
    }
    if (!ops.some((o) => o.sign)) return [];
    const keep = new Array(ops.length).fill(false);
    ops.forEach((o, k) => {
        if (!o.sign) return;
        for (let d = Math.max(0, k - context); d <= Math.min(ops.length - 1, k + context); d++) keep[d] = true;
    });
    const out = [];
    let last = -1;
    ops.forEach((o, k) => {
        if (!keep[k]) return;
        if (last >= 0 && k > last + 1) out.push({ gap: true, n: '', sign: '', text: '' });
        out.push({ n: o.nb >= 0 ? String(B.bodyStart + o.nb) : '', sign: o.sign, text: o.text });
        last = k;
    });
    return out;
}

/** A one-glance summary for the file list: "1 field", "+2 lines", "2 fields, −1 line". */
export function changeSummary(before, after, status) {
    if (status === 'new') return 'new';
    if (status === 'deleted') return 'deleted';
    const parts = [];
    const f = fieldChanges(before, after).length;
    if (f) parts.push(`${f} field${f === 1 ? '' : 's'}`);
    const t = textChanges(before, after, 0);
    if (t === null) parts.push('text');
    else if (t.length) {
        const add = t.filter((l) => l.sign === '+').length;
        const del = t.filter((l) => l.sign === '-').length;
        if (add) parts.push(`+${add} line${add === 1 ? '' : 's'}`);
        if (del) parts.push(`−${del} line${del === 1 ? '' : 's'}`);
    }
    return parts.join(', ') || 'no change';
}
