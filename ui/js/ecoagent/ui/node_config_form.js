/**
 * node_config_form.js — render an ETL node's config from its declarative
 * descriptor (docs/CALIBRATION_AND_ETL.md). One renderer for every node type;
 * no hand-coded fields, no JSON textareas.
 *
 *   renderNodeConfigForm(host, { descriptor, value, upstreamColumns, onChange })
 *
 * `descriptor.config` is a `{field: {type, label, default, options, when, …}}`
 * map. `value` is the node's live config object — mutated in place; `onChange`
 * fires after each edit. `column`/`columns` fields list `upstreamColumns`
 * (from the upstream node's preview) plus an "other…" escape. `when` gives
 * conditional visibility; the form re-renders when a dependency (select/
 * checkbox) changes so dependent fields appear/disappear.
 */

import { esc } from '../tabs/_util.js';

const NUM = new Set(['number']);

export function renderNodeConfigForm(host, { descriptor, value, upstreamColumns = [], onChange }) {
    value = value || {};
    const cfg = (descriptor && descriptor.config) || {};
    const fire = (k) => { try { onChange?.(k, value[k]); } catch { /* ignore */ } };

    const visible = (f) => {
        if (!f.when) return true;
        return (f.when.in || []).includes(value[f.when.field]);
    };

    // Seed defaults for visible fields that are unset.
    for (const [k, f] of Object.entries(cfg)) {
        if (value[k] === undefined && f.default !== undefined) value[k] = f.default;
    }

    const colOptions = (cur) => {
        const opts = (upstreamColumns || []).map((c) =>
            `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');
        const isOther = cur && !(upstreamColumns || []).includes(cur);
        return `<option value=""></option>${opts}<option value="__other"${isOther ? ' selected' : ''}>other…</option>`;
    };

    const control = (k, f) => {
        const v = value[k];
        const t = f.type;
        if (t === 'select' || t === 'combobox') {
            const opts = (f.options || []).map((o) => {
                const val = typeof o === 'string' ? o : o.value;
                const lab = (typeof o === 'string' ? o : (o.label || o.value));
                return `<option value="${esc(val)}"${String(val) === String(v ?? '') ? ' selected' : ''}>${esc(lab)}</option>`;
            }).join('');
            return `<select data-nf="${k}" data-rerender="1"><option value=""></option>${opts}</select>`;
        }
        if (t === 'number') return `<input type="number" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} step="${f.step ?? 'any'}" data-nf="${k}" value="${v ?? ''}" placeholder="${esc(f.placeholder || '')}">`;
        if (t === 'textarea') return `<textarea class="ea-calib__textarea" rows="5" data-nf="${k}" placeholder="${esc(f.placeholder || '')}">${esc(v ?? '')}</textarea>`;
        if (t === 'secret') return `<input type="password" data-nf="${k}" value="${esc(v ?? '')}" placeholder="${esc(f.placeholder || '')}">`;
        if (t === 'checkbox') return `<input type="checkbox" data-nf="${k}" data-rerender="1"${v ? ' checked' : ''}>`;
        if (t === 'column') return `<select data-nf="${k}" data-col="1">${colOptions(v)}</select>${(v && !upstreamColumns.includes(v)) || v === '__other' ? `<input class="ea-calib__col-other" data-nf-other="${k}" value="${esc(v === '__other' ? '' : (v ?? ''))}" placeholder="column name">` : ''}`;
        if (t === 'columns') {
            if (!upstreamColumns.length) return `<input data-nf="${k}" data-csv="1" value="${esc(Array.isArray(v) ? v.join(',') : (v ?? ''))}" placeholder="comma-separated (preview to list)">`;
            const set = new Set(Array.isArray(v) ? v : (v ? String(v).split(',').map((s) => s.trim()) : []));
            return `<span class="ea-calib__cols">${upstreamColumns.map((c) => `<label class="ea-calib__chk"><input type="checkbox" data-nf-col="${k}" value="${esc(c)}"${set.has(c) ? ' checked' : ''}> ${esc(c)}</label>`).join('')}</span>`;
        }
        if (t === 'keyvalue') {
            const entries = Object.entries(v || {});
            const rows = (entries.length ? entries : [['', '']]).map(([kk, vv], i) =>
                `<div class="ea-calib__kv" data-kv-i="${i}"><input data-kv-k="${k}" value="${esc(kk)}" placeholder="key"><input data-kv-v="${k}" value="${esc(vv)}" placeholder="value"></div>`).join('');
            return `<span class="ea-calib__kvs" data-kv="${k}">${rows}<button type="button" class="ea-btn ea-btn--small" data-kv-add="${k}">+ row</button></span>`;
        }
        if (t === 'expressions') {
            const list = Array.isArray(v) ? v : [];
            const rows = (list.length ? list : [{ output: '', formula: '' }]).map((e, i) =>
                `<div class="ea-calib__expr" data-expr-i="${i}"><input data-expr-out="${k}" value="${esc(e.output || '')}" placeholder="output col"><span>=</span><input class="ea-calib__mono" data-expr-f="${k}" value="${esc(e.formula || '')}" placeholder="value * 0.04"></div>`).join('');
            return `<span class="ea-calib__exprs" data-expr="${k}">${rows}<button type="button" class="ea-btn ea-btn--small" data-expr-add="${k}">+ expr</button></span>`;
        }
        // text (default)
        return `<input data-nf="${k}" value="${esc(v ?? '')}" placeholder="${esc(f.placeholder || '')}">`;
    };

    host.innerHTML = Object.entries(cfg).filter(([, f]) => visible(f)).map(([k, f]) => `
        <label class="ea-row${f.type === 'textarea' || f.type === 'expressions' || f.type === 'columns' ? ' ea-row--wide' : ''}" data-field="${k}">
            <span>${esc(f.label || k)}${f.required ? ' *' : ''}</span>
            <span class="ea-calib__field-ctl">${control(k, f)}</span>
        </label>${f.hint ? `<div class="ea-calib__hint-line">${esc(f.hint)}</div>` : ''}`).join('')
        || '<p class="ea-calib__muted">No configuration.</p>';

    const rerender = () => renderNodeConfigForm(host, { descriptor, value, upstreamColumns, onChange });

    host.querySelectorAll('[data-nf]').forEach((el) => {
        const k = el.dataset.nf;
        const f = cfg[k];
        const ev = (f && (f.type === 'select' || f.type === 'checkbox' || f.type === 'column')) ? 'change' : 'input';
        el.addEventListener(ev, () => {
            if (f && f.type === 'checkbox') value[k] = el.checked;
            else if (el.dataset.col && el.value === '__other') value[k] = '__other';
            else if (el.dataset.csv) value[k] = el.value;
            else value[k] = NUM.has(f?.type) ? (el.value === '' ? undefined : Number(el.value)) : el.value;
            fire(k);
            if (el.dataset.rerender || el.dataset.col) rerender();
        });
    });
    host.querySelectorAll('[data-nf-other]').forEach((el) => el.addEventListener('input', () => { value[el.dataset.nfOther] = el.value; fire(el.dataset.nfOther); }));
    host.querySelectorAll('[data-nf-col]').forEach((el) => el.addEventListener('change', () => {
        const k = el.dataset.nfCol;
        const checked = [...host.querySelectorAll(`[data-nf-col="${k}"]:checked`)].map((c) => c.value);
        value[k] = checked; fire(k);
    }));
    // keyvalue
    host.querySelectorAll('[data-kv]').forEach((span) => {
        const k = span.dataset.kv;
        const collect = () => {
            const obj = {};
            span.querySelectorAll('.ea-calib__kv').forEach((row) => {
                const kk = row.querySelector('[data-kv-k]').value.trim();
                const vv = row.querySelector('[data-kv-v]').value.trim();
                if (kk) obj[kk] = isFinite(Number(vv)) && vv !== '' ? Number(vv) : vv;
            });
            value[k] = obj; fire(k);
        };
        span.querySelectorAll('[data-kv-k],[data-kv-v]').forEach((i) => i.addEventListener('input', collect));
        span.querySelector('[data-kv-add]').addEventListener('click', () => {
            value[k] = { ...(value[k] || {}), '': '' }; rerender();
        });
    });
    // expressions
    host.querySelectorAll('[data-expr]').forEach((span) => {
        const k = span.dataset.expr;
        const collect = () => {
            const list = [];
            span.querySelectorAll('.ea-calib__expr').forEach((row) => {
                const out = row.querySelector('[data-expr-out]').value.trim();
                const formula = row.querySelector('[data-expr-f]').value.trim();
                if (out && formula) list.push({ output: out, formula });
            });
            value[k] = list; fire(k);
        };
        span.querySelectorAll('[data-expr-out],[data-expr-f]').forEach((i) => i.addEventListener('input', collect));
        span.querySelector('[data-expr-add]').addEventListener('click', () => {
            value[k] = [...(Array.isArray(value[k]) ? value[k] : []), { output: '', formula: '' }]; rerender();
        });
    });
}
