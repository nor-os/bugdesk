/**
 * ticketdesk/filter_editor.js — the Jira-style filter expression builder.
 *
 * WHAT: a self-contained modal overlay (BEM namespace `td-fed`) that edits a
 * BugDesk custom filter: its name, its icon, and its Group/Clause expression
 * tree, with a LIVE PREVIEW of the bugs the expression currently matches.
 *
 * WHY a hand-rolled overlay instead of ManagedWindow: the editor is a
 * blocking, single-purpose dialog that owns its own focus trap and an inline
 * confirm sheet; it never minimises, never docks, never joins the window
 * stack. It still obeys the app's overlay conventions — same backdrop dim and
 * the same z-tier as `.td-modal-backdrop` (11000, above the 6000-6999
 * ManagedWindow band) — so it stacks predictably with everything else.
 *
 * All domain logic (fields, operators, evaluation, persistence) lives in
 * ./filters.js. This file is pure UI: it never decides what a filter MEANS,
 * it only edits the AST and asks filters.js to describe/validate/evaluate it.
 *
 * Rendering strategy — the expression tree is re-rendered wholesale on every
 * STRUCTURAL change (add/remove/field/operator/AND-OR/NOT) and focus is then
 * restored via a data-path selector. Plain VALUE typing never re-renders; it
 * mutates the AST in place and only re-runs the debounced preview, so text
 * inputs keep their caret. `data-path` ("" = root, "0", "0.2" = nested child
 * index chain) is the single addressing scheme linking DOM back to AST.
 */

import {
    FILTER_FIELDS, OPERATORS, FILTER_ICONS,
    describeFilter, matcherFor, validateFilter, emptyExpr,
    saveFilter, deleteFilter,
} from './filters.js';
import { esc } from './data.js';

/* Icon grid geometry — the CSS grid is a fixed 8 columns, and the arrow-key
   handler needs the same number to move up/down a row. Keep in sync with
   `.td-fed__icongrid` in ticketdesk_filters.css. */
const ICON_COLS = 8;

/* Preview debounce: long enough to swallow a burst of keystrokes, short
   enough that the match count feels attached to the typing. */
const PREVIEW_DEBOUNCE_MS = 120;

/* Maximum number of matching bugs listed in the preview pane. */
const PREVIEW_LIMIT = 25;

/* Field <select> optgroup captions, keyed by FILTER_FIELDS[].type. */
const TYPE_GROUP = {
    text: 'Text',
    enum: 'Choice',
    set: 'Labels',
    number: 'Numbers',
    date: 'Dates',
};

/* Per-instance suffix for the one DOM id the dialog needs (label `for`),
   so two editors open at once can never collide on it. */
let _seq = 1;

const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/* ── AST + field helpers (pure) ─────────────────────────────────── */

/** Deep copy. The AST is JSON-serialisable by contract, so this is total. */
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

const fieldByKey = (key) => FILTER_FIELDS.find((f) => f.key === key) || null;

/** Operators legal for a clause's field. Unknown field → no operators, which
 *  makes the clause render its "unknown" fallbacks and validateFilter flag it
 *  rather than us silently swapping in a different field. */
function opsFor(fieldKey) {
    const f = fieldByKey(fieldKey);
    return (f && OPERATORS[f.type]) || [];
}
const opDef = (fieldKey, opId) => opsFor(fieldKey).find((o) => o.id === opId) || null;

/* FILTER_FIELDS[].options may be plain strings or {value,label} records —
   normalise both rather than assuming one shape. */
const optValue = (o) => (o && typeof o === 'object' ? (o.value ?? o.id ?? '') : String(o ?? ''));
const optLabel = (o) => (o && typeof o === 'object' ? (o.label ?? o.value ?? o.id ?? '') : String(o ?? ''));

/** "in the last N days" is the one arity-1 date operator whose control is a
 *  NUMBER, not a date. filters.js owns the id, so sniff id + label instead of
 *  hard-coding a string we don't own. */
const isRelativeDays = (op) => !!op && /day/i.test(`${op.id} ${op.label}`);

/** The value a freshly-picked (field, operator) pair should start from. */
function defaultValueFor(field, op) {
    if (!field || !op || !op.arity) return null;
    if (op.multi) return [];
    if (field.type === 'set') return '';
    if (op.arity === 2) return field.type === 'number' ? [null, null] : ['', ''];
    if (field.type === 'number') return null;
    if (field.type === 'date') return isRelativeDays(op) ? 7 : '';
    if (field.type === 'enum') return optValue((field.options || [])[0]);
    return '';
}

/** A clause seeded on the first field/operator — what "+ Condition" adds. */
function makeClause() {
    const field = FILTER_FIELDS[0];
    const op = (OPERATORS[field.type] || [])[0] || null;
    return {
        kind: 'clause',
        field: field.key,
        op: op ? op.id : '',
        value: defaultValueFor(field, op),
    };
}

/** Walk a dotted child-index path. "" is the root group. */
function nodeAt(root, path) {
    if (!path) return root;
    let node = root;
    for (const part of path.split('.')) {
        if (!node || !Array.isArray(node.children)) return null;
        node = node.children[Number(part)];
    }
    return node || null;
}
const parentPath = (path) => (path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '');
const lastIndex = (path) => Number(path.slice(path.lastIndexOf('.') + 1));

/** Root must be a group — a seedExpr may legitimately be a bare clause. */
function normaliseRoot(expr) {
    if (!expr || typeof expr !== 'object') return emptyExpr();
    if (expr.kind === 'group') return expr;
    return { kind: 'group', op: 'AND', children: [expr] };
}

/* ── the editor ─────────────────────────────────────────────────── */

/**
 * Open the filter editor modal.
 *
 * @param {object}   o
 * @param {object?}  o.filter    existing filter to edit (deep-cloned, so
 *                               Cancel is lossless). Falsy → create mode.
 * @param {object?}  o.seedExpr  expression to pre-populate in create mode
 *                               (the queue's "Save as filter" button).
 * @param {Array}    o.tickets   mapped tickets (ticketdesk/data.js) driving
 *                               the live preview.
 * @param {Function?} o.onSaved  called with the persisted filter after Save.
 * @param {Function?} o.onDeleted called with the id after Delete.
 */
export function openFilterEditor({
    filter = null, seedExpr = null, tickets = [], onSaved = null, onDeleted = null,
} = {}) {
    const editing = !!(filter && filter.id && !filter.builtin);

    const state = {
        id: filter && !filter.builtin ? (filter.id || null) : null,
        label: (filter && filter.label) || '',
        icon: (filter && filter.icon) || FILTER_ICONS[0] || 'filter_alt',
        expr: normaliseRoot(clone(filter ? filter.expr : seedExpr) || emptyExpr()),
        valid: true,
    };
    const snapshot = () => JSON.stringify({ label: state.label, icon: state.icon, expr: state.expr });
    const initialJson = snapshot();

    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const nameId = `td-fed-name-${_seq++}`;

    /* ── shell ──────────────────────────────────────────────────── */

    const overlay = document.createElement('div');
    overlay.className = 'td-fed';
    overlay.innerHTML = `
        <div class="td-fed__dialog" role="dialog" aria-modal="true" aria-label="${editing ? 'Edit filter' : 'New filter'}">
            <div class="td-fed__head">
                <span class="material-symbols-outlined td-fed__headicon">filter_alt</span>
                <span class="td-fed__title">${editing ? 'Edit filter' : 'New filter'}</span>
                <span class="td-fed__grow"></span>
                <button type="button" class="td-fed__close" data-act="cancel" title="Close" aria-label="Close">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>

            <div class="td-fed__body">
                <div class="td-fed__namerow">
                    <label class="td-fed__lbl" for="${nameId}">Name</label>
                    <input id="${nameId}" class="ea-tin td-fed__name" type="text" autocomplete="off"
                           placeholder="e.g. Crashers on me" value="${esc(state.label)}" />
                    <div class="td-fed__iconpick">
                        <button type="button" class="td-fed__iconbtn" data-act="iconbtn"
                                aria-haspopup="listbox" aria-expanded="false" title="Filter icon">
                            <span class="material-symbols-outlined td-fed__iconface">${esc(state.icon)}</span>
                            <span class="material-symbols-outlined td-fed__caret">expand_more</span>
                        </button>
                        <div class="td-fed__iconpop" hidden>
                            <input class="ea-tin td-fed__iconsearch" type="text" placeholder="Search icons…" aria-label="Search icons" />
                            <div class="td-fed__icongrid" role="listbox" aria-label="Filter icon"></div>
                            <div class="td-fed__iconempty" hidden>No icon matches.</div>
                        </div>
                    </div>
                </div>

                <div class="td-fed__cols">
                    <section class="td-fed__pane td-fed__pane--build">
                        <div class="td-fed__panehead">Conditions</div>
                        <div class="td-fed__tree" data-role="tree"></div>
                    </section>
                    <section class="td-fed__pane td-fed__pane--preview">
                        <div class="td-fed__panehead">Preview</div>
                        <div class="td-fed__preview" data-role="preview"></div>
                    </section>
                </div>
            </div>

            <div class="td-fed__saveerr" data-role="saveerr" hidden></div>

            <div class="td-fed__foot">
                <button type="button" class="ea-btn ea-btn--danger td-fed__delbtn" data-act="delete"${editing ? '' : ' hidden'}>Delete</button>
                <span class="td-fed__grow"></span>
                <button type="button" class="ea-btn" data-act="cancel">Cancel</button>
                <button type="button" class="ea-btn ea-btn--primary" data-act="save">Save</button>
            </div>

            <div class="td-fed__confirm" data-role="confirm" hidden>
                <div class="td-fed__confirmbox" role="alertdialog" aria-modal="true" aria-label="Confirm">
                    <div class="td-fed__confirmtitle" data-role="confirmtitle"></div>
                    <div class="td-fed__confirmbody" data-role="confirmbody"></div>
                    <div class="td-fed__confirmacts">
                        <button type="button" class="ea-btn" data-act="confirm-no">Keep editing</button>
                        <button type="button" class="ea-btn ea-btn--danger" data-act="confirm-yes">Discard</button>
                    </div>
                </div>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const $ = (sel) => overlay.querySelector(sel);
    const dialog = $('.td-fed__dialog');
    const nameInput = $('.td-fed__name');
    const treeEl = $('[data-role="tree"]');
    const previewEl = $('[data-role="preview"]');
    const saveBtn = $('[data-act="save"]');
    const saveErrEl = $('[data-role="saveerr"]');
    const confirmEl = $('[data-role="confirm"]');
    const confirmYes = $('[data-act="confirm-yes"]');
    const confirmNo = $('[data-act="confirm-no"]');
    const iconBtn = $('.td-fed__iconbtn');
    const iconFace = $('.td-fed__iconface');
    const iconPop = $('.td-fed__iconpop');
    const iconSearch = $('.td-fed__iconsearch');
    const iconGrid = $('.td-fed__icongrid');
    const iconEmpty = $('.td-fed__iconempty');

    let confirmAction = null;   // pending confirm callback, null when closed
    let previewTimer = 0;
    let closed = false;

    /* ── expression tree rendering ──────────────────────────────── */

    function fieldSelectHtml(selectedKey) {
        const groups = new Map();
        for (const f of FILTER_FIELDS) {
            const cap = TYPE_GROUP[f.type] || 'Other';
            if (!groups.has(cap)) groups.set(cap, []);
            groups.get(cap).push(f);
        }
        // An expression saved against a field we no longer know keeps its own
        // option so the select never silently rewrites the AST; validateFilter
        // is what tells the user it is broken.
        const unknown = selectedKey && !fieldByKey(selectedKey)
            ? `<option value="${esc(selectedKey)}" selected>${esc(selectedKey)} (unknown)</option>` : '';
        let html = unknown;
        for (const [cap, fields] of groups) {
            html += `<optgroup label="${esc(cap)}">`;
            for (const f of fields) {
                html += `<option value="${esc(f.key)}"${f.key === selectedKey ? ' selected' : ''}>${esc(f.label)}</option>`;
            }
            html += '</optgroup>';
        }
        return html;
    }

    function opSelectHtml(fieldKey, selectedOp) {
        const ops = opsFor(fieldKey);
        const unknown = selectedOp && !ops.some((o) => o.id === selectedOp)
            ? `<option value="${esc(selectedOp)}" selected>${esc(selectedOp)} (unknown)</option>` : '';
        return unknown + ops.map((o) =>
            `<option value="${esc(o.id)}"${o.id === selectedOp ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
    }

    /** Chip/token strip. `single` mode holds at most one token and stores a
     *  bare string (the arity-1 "contains this label" operators expect a
     *  scalar); multi mode stores an array. */
    function tokensHtml(value, { single = false, placeholder = 'add value…' } = {}) {
        const arr = Array.isArray(value) ? value : (value === '' || value == null ? [] : [value]);
        const chips = arr.map((v, i) => `
            <span class="td-fed__token">${esc(v)}<button type="button" class="td-fed__tokenx"
                data-act="chipdel" data-i="${i}" aria-label="Remove ${esc(v)}">×</button></span>`).join('');
        const input = single && arr.length
            ? ''
            : `<input class="td-fed__tokenin" data-role="vtok" type="text" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" />`;
        return `<div class="td-fed__tokens"${single ? ' data-single="1"' : ''}>${chips}${input}</div>`;
    }

    /** Multi-select over a fixed option list: chosen values as chips plus an
     *  "add" dropdown of what is left. */
    function enumMultiHtml(field, value) {
        const arr = Array.isArray(value) ? value : [];
        const opts = field.options || [];
        const labelOf = (v) => {
            const hit = opts.find((o) => optValue(o) === v);
            return hit ? optLabel(hit) : v;
        };
        const chips = arr.map((v, i) => `
            <span class="td-fed__token">${esc(labelOf(v))}<button type="button" class="td-fed__tokenx"
                data-act="chipdel" data-i="${i}" aria-label="Remove ${esc(labelOf(v))}">×</button></span>`).join('');
        const rest = opts.filter((o) => !arr.includes(optValue(o)));
        const add = rest.length
            ? `<select class="td-fed__tokenadd" data-role="vadd" aria-label="Add value">
                   <option value="">+ value</option>
                   ${rest.map((o) => `<option value="${esc(optValue(o))}">${esc(optLabel(o))}</option>`).join('')}
               </select>`
            : '';
        return `<div class="td-fed__tokens">${chips}${add}</div>`;
    }

    function valueHtml(field, op, value) {
        if (!field || !op || !op.arity) {
            return '<span class="td-fed__novalue">—</span>';
        }
        const t = field.type;
        if (t === 'set') {
            return tokensHtml(value, { single: !op.multi, placeholder: 'label…' });
        }
        if (op.multi) {
            return t === 'enum' ? enumMultiHtml(field, value) : tokensHtml(value, { placeholder: 'value…' });
        }
        if (t === 'enum') {
            const opts = field.options || [];
            const known = opts.some((o) => optValue(o) === value);
            const unknown = !known && value ? `<option value="${esc(value)}" selected>${esc(value)} (unknown)</option>` : '';
            return `<select class="ea-tin td-fed__vsel" data-role="v">${unknown}${opts.map((o) =>
                `<option value="${esc(optValue(o))}"${optValue(o) === value ? ' selected' : ''}>${esc(optLabel(o))}</option>`).join('')}</select>`;
        }
        if (t === 'number') {
            if (op.arity === 2) {
                const a = Array.isArray(value) ? value : [null, null];
                return `<input class="ea-tin td-fed__vin td-fed__vin--num" data-role="v0" data-num="1" type="number" value="${esc(a[0] ?? '')}" />
                        <span class="td-fed__and">and</span>
                        <input class="ea-tin td-fed__vin td-fed__vin--num" data-role="v1" data-num="1" type="number" value="${esc(a[1] ?? '')}" />`;
            }
            return `<input class="ea-tin td-fed__vin td-fed__vin--num" data-role="vnum" type="number" value="${esc(value ?? '')}" />`;
        }
        if (t === 'date') {
            if (isRelativeDays(op)) {
                return `<input class="ea-tin td-fed__vin td-fed__vin--num" data-role="vnum" type="number" min="0" value="${esc(value ?? '')}" />
                        <span class="td-fed__and">days</span>`;
            }
            if (op.arity === 2) {
                const a = Array.isArray(value) ? value : ['', ''];
                return `<input class="ea-tin td-fed__vin" data-role="v0" type="date" value="${esc(a[0] ?? '')}" />
                        <span class="td-fed__and">and</span>
                        <input class="ea-tin td-fed__vin" data-role="v1" type="date" value="${esc(a[1] ?? '')}" />`;
            }
            return `<input class="ea-tin td-fed__vin" data-role="v" type="date" value="${esc(value ?? '')}" />`;
        }
        // text
        if (op.arity === 2) {
            const a = Array.isArray(value) ? value : ['', ''];
            return `<input class="ea-tin td-fed__vin" data-role="v0" type="text" value="${esc(a[0] ?? '')}" />
                    <span class="td-fed__and">and</span>
                    <input class="ea-tin td-fed__vin" data-role="v1" type="text" value="${esc(a[1] ?? '')}" />`;
        }
        return `<input class="ea-tin td-fed__vin" data-role="v" type="text" value="${esc(value ?? '')}" placeholder="value…" />`;
    }

    function clauseHtml(clause, path) {
        const field = fieldByKey(clause.field);
        const op = opDef(clause.field, clause.op);
        return `
        <div class="td-fed__row td-fed__clause" data-path="${esc(path)}">
            <select class="ea-tin td-fed__sel td-fed__sel--field" data-role="field" aria-label="Field">
                ${fieldSelectHtml(clause.field)}
            </select>
            <select class="ea-tin td-fed__sel td-fed__sel--op" data-role="op" aria-label="Operator">
                ${opSelectHtml(clause.field, clause.op)}
            </select>
            <div class="td-fed__val" data-role="value">${valueHtml(field, op, clause.value)}</div>
            <button type="button" class="td-fed__x" data-act="del" title="Remove condition" aria-label="Remove condition">×</button>
        </div>`;
    }

    function groupHtml(group, path) {
        const isRoot = path === '';
        const children = (group.children || []).map((child, i) => {
            const childPath = isRoot ? String(i) : `${path}.${i}`;
            return `<div class="td-fed__child">${child && child.kind === 'group'
                ? groupHtml(child, childPath) : clauseHtml(child, childPath)}</div>`;
        }).join('');
        const on = (v) => (group.op === v ? ' is-on' : '');
        return `
        <div class="td-fed__group${isRoot ? ' td-fed__group--root' : ''}" data-path="${esc(path)}">
            <div class="td-fed__grouphead">
                <div class="td-fed__seg" role="group" aria-label="Match mode">
                    <button type="button" class="td-fed__segbtn${on('AND')}" data-act="setop" data-op="AND"
                            aria-pressed="${group.op === 'AND'}">AND</button>
                    <button type="button" class="td-fed__segbtn${on('OR')}" data-act="setop" data-op="OR"
                            aria-pressed="${group.op === 'OR'}">OR</button>
                </div>
                <button type="button" class="td-fed__not${group.negate ? ' is-on' : ''}" data-act="not"
                        aria-pressed="${!!group.negate}" title="Invert this group">NOT</button>
                <span class="td-fed__hint">${group.op === 'OR' ? 'any condition matches' : 'all conditions match'}</span>
                <span class="td-fed__grow"></span>
                ${isRoot ? '' : '<button type="button" class="td-fed__x" data-act="delgroup" title="Remove group" aria-label="Remove group">×</button>'}
            </div>
            <div class="td-fed__children">${children
                || '<div class="td-fed__noconds">No conditions — this group matches every bug.</div>'}</div>
            <div class="td-fed__groupfoot">
                <button type="button" class="ea-btn ea-btn--small" data-act="addclause">+ Condition</button>
                <button type="button" class="ea-btn ea-btn--small" data-act="addgroup">+ Group</button>
            </div>
        </div>`;
    }

    /* Focus-restore selectors. Groups nest, so every group-scoped selector
       uses CHILD combinators — a plain descendant selector would match the
       first nested group's button instead of this group's own. Paths are
       generated from array indices ("0", "0.2"), so they are always safe
       inside a quoted attribute selector. */
    const groupSel = (path, tail) => `.td-fed__group[data-path="${path}"] > ${tail}`;
    const clauseSel = (path, tail) => `.td-fed__clause[data-path="${path}"] ${tail}`;
    const addClauseSel = (path) => groupSel(path, '.td-fed__groupfoot > [data-act="addclause"]');

    /** Re-render the whole tree, then restore focus via a selector so the
     *  keyboard user is never dumped back at the top of the dialog. */
    function renderTree(focusSel) {
        treeEl.innerHTML = groupHtml(state.expr, '');
        if (focusSel) {
            const el = treeEl.querySelector(focusSel);
            if (el) el.focus();
        }
        schedulePreview();
    }

    /** Re-render just one clause's value cell (chip add/remove) — cheaper than
     *  a full tree render and keeps every other control's focus intact. */
    function refreshValueCell(path, focusToken) {
        const clause = nodeAt(state.expr, path);
        const host = treeEl.querySelector(clauseSel(path, '[data-role="value"]'));
        if (!clause || !host) return;
        host.innerHTML = valueHtml(fieldByKey(clause.field), opDef(clause.field, clause.op), clause.value);
        if (focusToken) host.querySelector('[data-role="vtok"], [data-role="vadd"]')?.focus();
        schedulePreview();
    }

    /* ── tree mutation ──────────────────────────────────────────── */

    /** Remove `path` from its parent, then collapse any nested group that the
     *  removal left empty (the root group is allowed to be empty). */
    function removeAt(path) {
        let p = path;
        while (p !== '') {
            const parent = nodeAt(state.expr, parentPath(p));
            if (!parent || !Array.isArray(parent.children)) return;
            parent.children.splice(lastIndex(p), 1);
            if (parent.children.length || parentPath(p) === '') return;
            p = parentPath(p);   // the parent group is now empty — drop it too
        }
    }

    treeEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || !treeEl.contains(btn)) return;
        const act = btn.dataset.act;

        if (act === 'chipdel') {
            const path = btn.closest('.td-fed__clause').dataset.path;
            const clause = nodeAt(state.expr, path);
            const op = opDef(clause.field, clause.op);
            if (Array.isArray(clause.value)) clause.value.splice(Number(btn.dataset.i), 1);
            else clause.value = defaultValueFor(fieldByKey(clause.field), op);
            refreshValueCell(path, true);
            return;
        }

        const holder = btn.closest('.td-fed__group, .td-fed__clause');
        if (!holder) return;
        const path = holder.dataset.path;

        if (act === 'setop') {
            const g = nodeAt(state.expr, path);
            if (!g || g.op === btn.dataset.op) return;
            g.op = btn.dataset.op;
            renderTree(groupSel(path, `.td-fed__grouphead > .td-fed__seg > [data-op="${btn.dataset.op}"]`));
        } else if (act === 'not') {
            const g = nodeAt(state.expr, path);
            g.negate = !g.negate;
            renderTree(groupSel(path, '.td-fed__grouphead > [data-act="not"]'));
        } else if (act === 'addclause') {
            const g = nodeAt(state.expr, path);
            g.children.push(makeClause());
            const childPath = path === '' ? String(g.children.length - 1) : `${path}.${g.children.length - 1}`;
            renderTree(clauseSel(childPath, '[data-role="field"]'));
        } else if (act === 'addgroup') {
            const g = nodeAt(state.expr, path);
            // Seeded with one condition: an empty group matches everything,
            // which reads as a bug the moment it appears in the preview.
            g.children.push({ kind: 'group', op: 'AND', children: [makeClause()] });
            const childPath = path === '' ? String(g.children.length - 1) : `${path}.${g.children.length - 1}`;
            renderTree(addClauseSel(childPath));
        } else if (act === 'del' || act === 'delgroup') {
            const parent = parentPath(path);
            removeAt(path);
            // The parent group may itself have been collapsed by removeAt, in
            // which case that path now addresses a different node (or none) —
            // fall back to the root group's footer.
            const host = nodeAt(state.expr, parent);
            renderTree(addClauseSel(host && host.kind === 'group' ? parent : ''));
        }
    });

    treeEl.addEventListener('change', (e) => {
        const el = e.target;
        const role = el.dataset ? el.dataset.role : null;
        if (!role) return;
        const row = el.closest('.td-fed__clause');
        if (!row) return;
        const path = row.dataset.path;
        const clause = nodeAt(state.expr, path);
        if (!clause) return;

        if (role === 'field') {
            clause.field = el.value;
            const field = fieldByKey(clause.field);
            const op = (field && (OPERATORS[field.type] || [])[0]) || null;
            clause.op = op ? op.id : '';
            clause.value = defaultValueFor(field, op);
            renderTree(clauseSel(path, '[data-role="field"]'));
        } else if (role === 'op') {
            clause.op = el.value;
            clause.value = defaultValueFor(fieldByKey(clause.field), opDef(clause.field, clause.op));
            renderTree(clauseSel(path, '[data-role="op"]'));
        } else if (role === 'vadd') {
            if (!el.value) return;
            if (!Array.isArray(clause.value)) clause.value = [];
            clause.value.push(el.value);
            refreshValueCell(path, true);
        } else if (role === 'v' || role === 'vnum' || role === 'v0' || role === 'v1') {
            readControlValue(clause, role, el);
            schedulePreview();
        }
    });

    // Typing in a value control mutates the AST in place — no re-render, so
    // the caret survives.
    treeEl.addEventListener('input', (e) => {
        const el = e.target;
        const role = el.dataset ? el.dataset.role : null;
        if (!role || !['v', 'vnum', 'v0', 'v1'].includes(role)) return;
        const row = el.closest('.td-fed__clause');
        const clause = row && nodeAt(state.expr, row.dataset.path);
        if (!clause) return;
        readControlValue(clause, role, el);
        schedulePreview();
    });

    function readControlValue(clause, role, el) {
        const numeric = role === 'vnum' || el.dataset.num === '1';
        const parse = (raw) => (numeric ? (raw === '' ? null : Number(raw)) : raw);
        if (role === 'v' || role === 'vnum') {
            clause.value = parse(el.value);
        } else {
            const i = role === 'v0' ? 0 : 1;
            const arr = Array.isArray(clause.value) ? clause.value.slice() : ['', ''];
            arr[i] = parse(el.value);
            clause.value = arr;
        }
    }

    /** Commit a typed token (Enter / comma / blur) into a set-or-multi value. */
    function commitToken(input) {
        const raw = input.value.trim().replace(/,+$/, '');
        if (!raw) return false;
        const row = input.closest('.td-fed__clause');
        const clause = row && nodeAt(state.expr, row.dataset.path);
        if (!clause) return false;
        const single = input.closest('.td-fed__tokens')?.dataset.single === '1';
        if (single) {
            clause.value = raw;
        } else {
            if (!Array.isArray(clause.value)) clause.value = [];
            if (!clause.value.includes(raw)) clause.value.push(raw);
        }
        input.value = '';
        refreshValueCell(row.dataset.path, true);
        return true;
    }

    treeEl.addEventListener('keydown', (e) => {
        if (e.target.dataset?.role !== 'vtok') return;
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commitToken(e.target);
        } else if (e.key === 'Backspace' && !e.target.value) {
            // Backspace on an empty token input eats the previous chip.
            const row = e.target.closest('.td-fed__clause');
            const clause = row && nodeAt(state.expr, row.dataset.path);
            if (clause && Array.isArray(clause.value) && clause.value.length) {
                e.preventDefault();
                clause.value.pop();
                refreshValueCell(row.dataset.path, true);
            }
        }
    });
    // A chip's × has to survive the token input losing focus. Left alone,
    // pressing it moves focus, `focusout` commits whatever was typed, and
    // commitToken rebuilds the whole value cell — so the button being
    // pressed is destroyed before mouseup and the click never lands.
    // Suppressing the default focus shift keeps the input focused, so no
    // rebuild happens between press and release; the click handler above
    // then removes the chip normally.
    treeEl.addEventListener('mousedown', (e) => {
        if (e.target.closest?.('[data-act="chipdel"]')) e.preventDefault();
    });
    treeEl.addEventListener('focusout', (e) => {
        if (e.target.dataset?.role === 'vtok' && e.target.value.trim()) commitToken(e.target);
    });

    /* ── live preview ───────────────────────────────────────────── */

    const sevOf = (t) => String(t.severity || '').toLowerCase();

    function hitHtml(t) {
        return `
        <li class="td-fed__hit">
            <span class="td-fed__hitid">${esc(t.id)}</span>
            <span class="td-fed__dot td-fed__dot--${esc(sevOf(t) || 'low')}" title="${esc(t.severity || '')}"></span>
            <span class="td-fed__hittitle">${esc(t.summary || '')}</span>
            <span class="td-fed__hitstatus">${esc(t.status || '')}</span>
        </li>`;
    }

    function renderPreview() {
        const check = validateFilter(state.expr);
        state.valid = !!(check && check.ok);
        if (!state.valid) {
            const errors = (check && check.errors) || ['Invalid expression.'];
            previewEl.innerHTML = `
                <div class="td-fed__invalid">
                    <div class="td-fed__invalidhead">
                        <span class="material-symbols-outlined">error</span> This filter is not valid yet
                    </div>
                    <ul class="td-fed__errlist">${errors.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
                </div>`;
            updateSave();
            return;
        }

        let sentence = '';
        let hits = [];
        try {
            sentence = describeFilter(state.expr) || 'Matches every bug';
            const match = matcherFor(state.expr);
            hits = tickets.filter((t) => match(t));
        } catch (err) {
            // Surface the failure rather than pretending the filter matches
            // nothing — a throwing matcher is a real bug worth seeing.
            state.valid = false;
            previewEl.innerHTML = `
                <div class="td-fed__invalid">
                    <div class="td-fed__invalidhead">
                        <span class="material-symbols-outlined">error</span> Preview failed
                    </div>
                    <ul class="td-fed__errlist"><li>${esc(err && err.message ? err.message : String(err))}</li></ul>
                </div>`;
            updateSave();
            return;
        }

        const shown = hits.slice(0, PREVIEW_LIMIT);
        const more = hits.length - shown.length;
        previewEl.innerHTML = `
            <div class="td-fed__sentence">${esc(sentence)}</div>
            <div class="td-fed__count">
                <b>${hits.length}</b> of ${tickets.length} bug${tickets.length === 1 ? '' : 's'} match${hits.length === 1 ? 'es' : ''}
            </div>
            ${hits.length
                ? `<ul class="td-fed__list">${shown.map(hitHtml).join('')}</ul>
                   ${more > 0 ? `<div class="td-fed__more">+ ${more} more not shown</div>` : ''}`
                : `<div class="td-fed__none">
                       <span class="material-symbols-outlined">search_off</span>
                       No bug matches this filter.
                   </div>`}`;
        updateSave();
    }

    function schedulePreview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(renderPreview, PREVIEW_DEBOUNCE_MS);
    }

    // Guards against a double-create: the button's own disabled flag is not
    // enough, because a debounced preview lands mid-POST and updateSave()
    // hands the button straight back to the user while the request is still
    // open — a second click would then save a second copy under a fresh id.
    let saving = false;

    function updateSave() {
        saveBtn.disabled = saving || !state.valid || !state.label.trim();
    }

    nameInput.addEventListener('input', () => {
        state.label = nameInput.value;
        updateSave();
    });

    /* ── icon picker popover ────────────────────────────────────── */

    function iconOptionsHtml(query) {
        const q = query.trim().toLowerCase();
        const list = q ? FILTER_ICONS.filter((n) => n.toLowerCase().includes(q)) : FILTER_ICONS;
        iconEmpty.hidden = list.length > 0;
        return list.map((n) => `
            <button type="button" class="td-fed__iconopt${n === state.icon ? ' is-on' : ''}" role="option"
                    aria-selected="${n === state.icon}" data-icon="${esc(n)}" title="${esc(n)}">
                <span class="material-symbols-outlined">${esc(n)}</span>
            </button>`).join('');
    }

    const iconPopOpen = () => !iconPop.hidden;

    function openIconPop() {
        iconGrid.innerHTML = iconOptionsHtml('');
        iconPop.hidden = false;
        iconBtn.setAttribute('aria-expanded', 'true');
        iconSearch.value = '';
        iconSearch.focus();
    }
    function closeIconPop(refocus = true) {
        if (!iconPopOpen()) return;
        iconPop.hidden = true;
        iconBtn.setAttribute('aria-expanded', 'false');
        if (refocus) iconBtn.focus();
    }
    function pickIcon(name) {
        state.icon = name;
        iconFace.textContent = name;
        closeIconPop();
        updateSave();
    }

    iconBtn.addEventListener('click', () => (iconPopOpen() ? closeIconPop() : openIconPop()));
    iconSearch.addEventListener('input', () => { iconGrid.innerHTML = iconOptionsHtml(iconSearch.value); });
    iconSearch.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            iconGrid.querySelector('.td-fed__iconopt')?.focus();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const first = iconGrid.querySelector('.td-fed__iconopt');
            if (first) pickIcon(first.dataset.icon);
        }
    });
    iconGrid.addEventListener('click', (e) => {
        const opt = e.target.closest('.td-fed__iconopt');
        if (opt) pickIcon(opt.dataset.icon);
    });
    iconGrid.addEventListener('keydown', (e) => {
        const opt = e.target.closest('.td-fed__iconopt');
        if (!opt) return;
        const items = [...iconGrid.querySelectorAll('.td-fed__iconopt')];
        const i = items.indexOf(opt);
        const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: ICON_COLS, ArrowUp: -ICON_COLS }[e.key];
        if (step !== undefined) {
            e.preventDefault();
            const next = i + step;
            if (next < 0 && e.key === 'ArrowUp') { iconSearch.focus(); return; }
            if (next >= 0 && next < items.length) items[next].focus();
        } else if (e.key === 'Home') {
            e.preventDefault(); items[0]?.focus();
        } else if (e.key === 'End') {
            e.preventDefault(); items[items.length - 1]?.focus();
        }
    });
    // A click anywhere else in the dialog dismisses the popover.
    dialog.addEventListener('mousedown', (e) => {
        if (iconPopOpen() && !e.target.closest('.td-fed__iconpick')) closeIconPop(false);
    });

    /* ── confirm sheet (discard / delete) ───────────────────────── */

    function askConfirm({ title, body, confirmLabel, cancelLabel = 'Keep editing', onYes }) {
        $('[data-role="confirmtitle"]').textContent = title;
        $('[data-role="confirmbody"]').textContent = body;
        confirmYes.textContent = confirmLabel;
        confirmNo.textContent = cancelLabel;
        confirmAction = onYes;
        confirmEl.hidden = false;
        confirmYes.focus();
    }
    function closeConfirm() {
        confirmEl.hidden = true;
        confirmAction = null;
    }
    confirmNo.addEventListener('click', closeConfirm);
    confirmYes.addEventListener('click', () => {
        const fn = confirmAction;
        closeConfirm();
        fn?.();
    });

    /* ── save / delete / close ──────────────────────────────────── */

    function showSaveError(msg) {
        saveErrEl.textContent = msg;
        saveErrEl.hidden = !msg;
    }

    async function doSave() {
        const label = nameInput.value.trim();
        if (saving || !label || !state.valid) return;
        showSaveError('');
        saving = true;
        updateSave();
        try {
            const saved = await saveFilter({
                id: state.id || null,
                label,
                icon: state.icon,
                expr: state.expr,
                builtin: false,
            });
            onSaved?.(saved);
            close();
        } catch (err) {
            showSaveError(`Save failed: ${err && err.message ? err.message : String(err)}`);
        } finally {
            saving = false;
            updateSave();
        }
    }

    function doDelete() {
        if (!state.id) return;
        askConfirm({
            title: 'Delete this filter?',
            body: `"${nameInput.value.trim() || state.label}" will be removed from the filter rail. This cannot be undone.`,
            confirmLabel: 'Delete',
            cancelLabel: 'Cancel',
            onYes: async () => {
                showSaveError('');
                try {
                    await deleteFilter(state.id);
                    onDeleted?.(state.id);
                    close();
                } catch (err) {
                    showSaveError(`Delete failed: ${err && err.message ? err.message : String(err)}`);
                }
            },
        });
    }

    /* state.label tracks the name input on every keystroke, so the snapshot
       covers the name, the icon and the whole expression. */
    const isDirty = () => snapshot() !== initialJson;

    function requestClose() {
        if (!isDirty()) { close(); return; }
        askConfirm({
            title: 'Discard changes?',
            body: 'This filter has unsaved changes. Closing now throws them away.',
            confirmLabel: 'Discard',
            onYes: close,
        });
    }

    function close() {
        if (closed) return;
        closed = true;
        clearTimeout(previewTimer);
        document.removeEventListener('keydown', onKeydown, true);
        overlay.remove();
        returnFocus?.focus?.();
    }

    overlay.addEventListener('click', (e) => {
        // Backdrop click == Cancel (same unsaved-changes guard).
        if (e.target === overlay && confirmEl.hidden) requestClose();
    });
    dialog.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'cancel') requestClose();
        else if (act === 'save') doSave();
        else if (act === 'delete') doDelete();
    });

    /* ── focus trap + Esc ───────────────────────────────────────── */

    function focusables(scope) {
        return [...scope.querySelectorAll(FOCUSABLE)]
            .filter((el) => el.offsetParent !== null || el === document.activeElement);
    }

    function onKeydown(e) {
        if (!overlay.isConnected) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (iconPopOpen()) closeIconPop();
            else if (!confirmEl.hidden) closeConfirm();
            else requestClose();
            return;
        }
        if (e.key !== 'Tab') return;
        // The confirm sheet is modal within the modal — trap inside it.
        const scope = confirmEl.hidden ? dialog : confirmEl;
        const items = focusables(scope);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (!scope.contains(active)) {
            e.preventDefault();
            first.focus();
        } else if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    }
    document.addEventListener('keydown', onKeydown, true);

    /* ── boot ───────────────────────────────────────────────────── */

    renderTree();
    renderPreview();
    updateSave();
    nameInput.focus();
    nameInput.select();
}
