/**
 * ticketdesk/record_diff.js — what changed in a record, said the way the record
 * is read rather than the way git stores it.
 *
 * A record file is front matter (one `key: value` per field) and a markdown
 * body. `git diff` shows an edit to either as a pair of YAML lines inside a
 * hunk with four lines of headers above it; the Changes pane shows the two
 * halves separately instead, in FlexDesk's diff viewer:
 *
 *   FIELDS  each front-matter key whose value differs: Severity high → critical
 *   TEXT    the body, line by line, numbered as in the file
 *
 * Both are worked out from the committed and the current text of the file
 * (GET /api/git/diff returns both), so nothing here depends on git's output.
 */

import { computeLineDiff, diffStats } from '@flexdesk/git';

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

/** A body as the text to compare. Every line keeps its line end, so the empty last
 *  line a final newline leaves in the body is a line like any other, and adding or
 *  removing that newline is a change. */
const bodyText = (body) => body.map((line) => `${line}\n`).join('');

/**
 * What the diff viewer draws for one record: the two bodies, numbered as in the
 * file, and the changed fields.
 * @param {{before: string, after: string, diff: string}} t  the file's two versions and git's diff
 */
export function recordDiffData({ before, after, diff }) {
    const A = splitRecord(before);
    const B = splitRecord(after);
    return {
        before: bodyText(A.body), after: bodyText(B.body),
        beforeStart: A.bodyStart, afterStart: B.bodyStart,
        diff, fields: fieldChanges(before, after),
    };
}

/** A one-glance summary for the file list: "1 field", "+2 lines", "2 fields, −1 line". */
export function changeSummary(before, after, status) {
    if (status === 'new') return 'new';
    if (status === 'deleted') return 'deleted';
    const parts = [];
    const f = fieldChanges(before, after).length;
    if (f) parts.push(`${f} field${f === 1 ? '' : 's'}`);
    const lines = computeLineDiff(bodyText(splitRecord(before).body), bodyText(splitRecord(after).body), { context: 0 });
    if (lines === null) parts.push('text');
    else {
        const { added, removed } = diffStats(lines);
        if (added) parts.push(`+${added} line${added === 1 ? '' : 's'}`);
        if (removed) parts.push(`−${removed} line${removed === 1 ? '' : 's'}`);
    }
    return parts.join(', ') || 'no change';
}
