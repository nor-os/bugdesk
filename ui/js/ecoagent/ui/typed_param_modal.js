/**
 * typed_param_modal.js — grid-style editors for the three structured
 * ParamSpec types added 2026-05-23:
 *
 *   'map'         — Dict<string, number>          → openMapEditor
 *   'schedule'    — List<[tick:int, value:float]> → openScheduleEditor
 *   'string_list' — List<string>                  → openStringListEditor
 *
 * Each editor opens a modal with an inline grid (add/remove rows,
 * typed inputs per column) and resolves with the edited value, or
 * `null` if the user cancels.
 *
 * All three go through `openModal` so chrome / Esc / focus trap /
 * Cmd+Enter "apply" match every other modal in the app.
 */

import { openModal } from './modal.js';


// ────────────────────────────────────────────────────────────────────── map

export async function openMapEditor(initial = {}, opts = {}) {
    const { title = 'Edit map', hint, keyLabel = 'Key', valueLabel = 'Value' } = opts;
    const rows = _entries(initial).map(
        ([k, v]) => ({ key: String(k), value: _num(v) }));

    const content = _makeBody(hint);
    const body    = content.querySelector('[data-role="body"]');

    const repaint = () => {
        body.innerHTML = `
            <table class="ea-typed-table">
                <thead><tr>
                    <th>${_esc(keyLabel)}</th>
                    <th>${_esc(valueLabel)}</th>
                    <th class="ea-typed-table__remove"></th>
                </tr></thead>
                <tbody>${rows.map((r, i) => `
                    <tr data-i="${i}">
                        <td><input class="ea-typed-input" data-field="key"
                                   value="${_esc(r.key)}" placeholder="e.g. bubill_6m"></td>
                        <td><input class="ea-typed-input" type="number" step="any"
                                   data-field="value" value="${_numAttr(r.value)}"
                                   placeholder="0"></td>
                        <td>
                            <button type="button" class="ea-typed-table__remove-btn"
                                    title="Remove row" data-action="remove">
                                <span class="material-symbols-outlined">close</span>
                            </button>
                        </td>
                    </tr>`).join('')}
                </tbody>
            </table>
            <button type="button" class="ea-typed-table__add"
                    data-action="add-row">+ Add row</button>
            <div class="ea-typed-table__sum" data-role="sum"></div>
        `;
        body.querySelectorAll('tr[data-i]').forEach((tr) => {
            const i = Number(tr.dataset.i);
            tr.querySelector('[data-field="key"]')
                .addEventListener('input', (e) => { rows[i].key = e.target.value; _updateSum(); });
            tr.querySelector('[data-field="value"]')
                .addEventListener('input', (e) => {
                    const n = Number(e.target.value);
                    rows[i].value = Number.isFinite(n) ? n : 0;
                    _updateSum();
                });
            tr.querySelector('[data-action="remove"]')
                .addEventListener('click', () => { rows.splice(i, 1); repaint(); });
        });
        body.querySelector('[data-action="add-row"]')
            .addEventListener('click', () => { rows.push({ key: '', value: 0 }); repaint(); });
        _updateSum();
    };
    // Live "Σ = X" footer — useful for normalized-weight maps like the
    // DMO bond ladder (user wants Σ ≈ 1).
    const _updateSum = () => {
        const sum = rows.reduce((s, r) =>
            s + (Number.isFinite(r.value) ? r.value : 0), 0);
        const el = body.querySelector('[data-role="sum"]');
        if (!el) return;
        el.textContent =
            `Σ = ${sum.toFixed(4).replace(/\.?0+$/, '')}  ·  `
            + `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`;
    };

    const result = await openModal({
        title, icon: 'grid_view', content,
        width: 520, height: 520,
        actions: [
            { label: 'Cancel', value: null },
            { label: 'Apply',  value: '__apply__', primary: true },
        ],
        onMount: repaint,
    });
    if (result !== '__apply__') return null;
    const out = {};
    for (const r of rows) {
        const k = (r.key ?? '').trim();
        if (!k) continue;
        out[k] = Number.isFinite(r.value) ? r.value : 0;
    }
    return out;
}


// ───────────────────────────────────────────────────────────────── schedule

export async function openScheduleEditor(initial = [], opts = {}) {
    const {
        title = 'Edit schedule',
        hint  = 'Piecewise-constant schedule: each row holds from tick T until the next row.',
        tickLabel = 'From tick',
        valueLabel = 'Value',
    } = opts;
    const rows = (Array.isArray(initial) ? initial : []).map((r) => ({
        tick:  Number.isFinite(Number(r?.[0])) ? Math.trunc(Number(r[0])) : 0,
        value: Number.isFinite(Number(r?.[1])) ? Number(r[1]) : 0,
    }));

    const content = _makeBody(hint);
    const body    = content.querySelector('[data-role="body"]');

    const repaint = () => {
        body.innerHTML = `
            <table class="ea-typed-table">
                <thead><tr>
                    <th>${_esc(tickLabel)}</th>
                    <th>${_esc(valueLabel)}</th>
                    <th class="ea-typed-table__remove"></th>
                </tr></thead>
                <tbody>${rows.map((r, i) => `
                    <tr data-i="${i}">
                        <td><input class="ea-typed-input" type="number" step="1"
                                   data-field="tick" value="${r.tick}" placeholder="0"></td>
                        <td><input class="ea-typed-input" type="number" step="any"
                                   data-field="value" value="${_numAttr(r.value)}"
                                   placeholder="0"></td>
                        <td>
                            <button type="button" class="ea-typed-table__remove-btn"
                                    title="Remove row" data-action="remove">
                                <span class="material-symbols-outlined">close</span>
                            </button>
                        </td>
                    </tr>`).join('')}
                </tbody>
            </table>
            <button type="button" class="ea-typed-table__add"
                    data-action="add-row">+ Add row</button>
        `;
        body.querySelectorAll('tr[data-i]').forEach((tr) => {
            const i = Number(tr.dataset.i);
            tr.querySelector('[data-field="tick"]')
                .addEventListener('input', (e) => {
                    const n = Number(e.target.value);
                    rows[i].tick = Number.isFinite(n) ? Math.trunc(n) : 0;
                });
            tr.querySelector('[data-field="value"]')
                .addEventListener('input', (e) => {
                    const n = Number(e.target.value);
                    rows[i].value = Number.isFinite(n) ? n : 0;
                });
            tr.querySelector('[data-action="remove"]')
                .addEventListener('click', () => { rows.splice(i, 1); repaint(); });
        });
        body.querySelector('[data-action="add-row"]')
            .addEventListener('click', () => {
                const lastTick = rows.length ? rows[rows.length - 1].tick : 0;
                rows.push({ tick: lastTick + 1, value: 0 });
                repaint();
            });
    };

    const result = await openModal({
        title, icon: 'schedule', content,
        width: 520, height: 520,
        actions: [
            { label: 'Cancel', value: null },
            { label: 'Apply',  value: '__apply__', primary: true },
        ],
        onMount: repaint,
    });
    if (result !== '__apply__') return null;
    return rows
        .filter((r) => Number.isFinite(r.tick))
        .map((r) => [Math.trunc(r.tick), Number.isFinite(r.value) ? r.value : 0])
        .sort((a, b) => a[0] - b[0]);
}


// ────────────────────────────────────────────────────────────────── strings

export async function openStringListEditor(initial = [], opts = {}) {
    const {
        title = 'Edit list',
        hint,
        placeholder = 'type and press Enter',
        suggestions = null,
    } = opts;
    const items = (Array.isArray(initial) ? initial : []).map((s) => String(s));

    const content = _makeBody(hint);
    const body    = content.querySelector('[data-role="body"]');
    const dlId    = `ea-typed-strlist-${Math.random().toString(36).slice(2, 8)}`;
    const dlHtml  = Array.isArray(suggestions) && suggestions.length
        ? `<datalist id="${dlId}">${
            suggestions.map((s) => `<option value="${_esc(s)}">`).join('')
          }</datalist>`
        : '';

    const repaint = () => {
        body.innerHTML = `
            <div class="ea-typed-chips" data-role="chips">
                ${items.map((s, i) => `
                    <span class="ea-typed-chip" data-i="${i}">
                        <span class="ea-typed-chip__label">${_esc(s)}</span>
                        <button type="button" class="ea-typed-chip__remove"
                                data-action="remove" title="Remove">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </span>`).join('')}
            </div>
            <div class="ea-typed-table__add-row">
                <input class="ea-typed-input" type="text"
                       data-role="new-item"
                       list="${dlId}"
                       placeholder="${_esc(placeholder)}"
                       autocomplete="off">
                <button type="button" class="ea-typed-table__add"
                        data-action="add-row">+ Add</button>
            </div>
            ${dlHtml}
        `;
        body.querySelectorAll('.ea-typed-chip').forEach((chip) => {
            const i = Number(chip.dataset.i);
            chip.querySelector('[data-action="remove"]')
                .addEventListener('click', () => { items.splice(i, 1); repaint(); });
        });
        const input  = body.querySelector('[data-role="new-item"]');
        const addBtn = body.querySelector('[data-action="add-row"]');
        const commit = () => {
            const v = input.value.trim();
            if (!v) return;
            if (!items.includes(v)) items.push(v);
            repaint();
            setTimeout(() => body.querySelector('[data-role="new-item"]')?.focus(), 0);
        };
        addBtn.addEventListener('click', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Backspace' && input.value === '' && items.length) {
                items.pop(); repaint();
                setTimeout(() => body.querySelector('[data-role="new-item"]')?.focus(), 0);
            }
        });
        input.focus();
    };

    const result = await openModal({
        title, icon: 'list', content,
        width: 480, height: 460,
        actions: [
            { label: 'Cancel', value: null },
            { label: 'Apply',  value: '__apply__', primary: true },
        ],
        onMount: repaint,
    });
    if (result !== '__apply__') return null;
    return items.filter((s) => s.trim().length > 0);
}


// ─────────────────────────────────────────────────────────────── summaries

/** One-line preview text for a param's structured value — shown on the
 *  Default cell button so the user knows what's inside without opening
 *  the editor. */
export function structuredSummary(type, value) {
    if (value == null) return '—';
    if (type === 'map') {
        const n = Object.keys(value || {}).length;
        const sample = Object.entries(value || {})
            .slice(0, 2)
            .map(([k, v]) => `${k}=${_fmtNum(v)}`)
            .join(', ');
        return n === 0 ? '{empty}'
            : `{${n} entr${n === 1 ? 'y' : 'ies'}${sample ? ` · ${sample}${n > 2 ? '…' : ''}` : ''}}`;
    }
    if (type === 'schedule') {
        const arr = Array.isArray(value) ? value : [];
        const n = arr.length;
        if (n === 0) return '[empty]';
        const first = arr[0];
        return `[${n} step${n === 1 ? '' : 's'} · from t${first?.[0] ?? '?'}=${_fmtNum(first?.[1])}]`;
    }
    if (type === 'string_list') {
        const arr = Array.isArray(value) ? value : [];
        const n = arr.length;
        if (n === 0) return '[]';
        const preview = arr.slice(0, 2).join(', ');
        return `${n} item${n === 1 ? '' : 's'} · ${preview}${n > 2 ? '…' : ''}`;
    }
    return String(value);
}


// ──────────────────────────────────────────────────────────────── helpers

function _makeBody(hint) {
    const el = document.createElement('div');
    el.className = 'ea-typed-modal__content';
    el.innerHTML = `
        ${hint ? `<p class="ea-modal__hint">${_esc(hint)}</p>` : ''}
        <div data-role="body"></div>
    `;
    return el;
}

function _entries(v) {
    if (Array.isArray(v))  return v.map((row) => Array.isArray(row) ? row : [String(row), 0]);
    if (v && typeof v === 'object') return Object.entries(v);
    return [];
}

function _num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function _numAttr(v) {
    return Number.isFinite(v) ? String(v) : '0';
}

function _fmtNum(v) {
    if (v == null) return '—';
    if (typeof v !== 'number') return String(v);
    if (!Number.isFinite(v)) return '—';
    return Number(v.toFixed(4)).toString();
}

function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
