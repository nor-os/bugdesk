/**
 * distribution_modal.js — modal editor for parameter distributions.
 *
 * Shape matches Ecosim's parameter-cell distributions
 * (see ui/js/notebook/scenario_param_renderer.js):
 *
 *   { type: 'none' }
 *   { type: 'uniform',     min, max }
 *   { type: 'normal',      mean, stddev }
 *   { type: 'lognormal',   mu, sigma }
 *   { type: 'triangular',  min, mode, max }
 *   { type: 'beta',        alpha, beta }
 *   { type: 'discrete',    values: [number, ...] }
 *
 * Returns the resolved distribution dict (or {type:'none'}) on save,
 * `undefined` on cancel. Built on `openModal` so the chrome / Esc /
 * focus trap match every other modal in the app.
 */

import { openModal } from './modal.js';

const KIND_LABELS = {
    none:        'Constant (use Default)',
    uniform:     'Uniform',
    normal:      'Normal',
    lognormal:   'Log-normal',
    triangular:  'Triangular',
    beta:        'Beta',
    discrete:    'Discrete',
};

const KIND_FIELDS = {
    none:        [],
    uniform:     [['min', 'Min'], ['max', 'Max']],
    normal:      [['mean', 'Mean'], ['stddev', 'StdDev']],
    lognormal:   [['mu', 'μ (mean of log)'], ['sigma', 'σ (sd of log)']],
    triangular:  [['min', 'Min'], ['mode', 'Mode'], ['max', 'Max']],
    beta:        [['alpha', 'α (alpha)'], ['beta', 'β (beta)']],
    discrete:    [['values', 'Values (comma-separated)', 'text']],
};


export async function openDistributionModal(initial = null) {
    const current = (initial && typeof initial === 'object')
        ? { ...initial } : { type: 'none' };
    if (!current.type) current.type = 'none';

    // Build the body — same form layout the legacy modal had, just
    // without the outer .ea-modal__overlay wrapper. openModal owns
    // the chrome.
    const content = document.createElement('div');
    content.className = 'ea-modal__form';
    content.innerHTML = `
        <label class="ea-modal__row">
            <span>Kind</span>
            <select data-role="dist-kind"></select>
        </label>
        <div data-role="dist-fields"></div>
    `;

    const kindSel    = content.querySelector('[data-role="dist-kind"]');
    const fieldsHost = content.querySelector('[data-role="dist-fields"]');

    for (const [k, lbl] of Object.entries(KIND_LABELS)) {
        const opt = document.createElement('option');
        opt.value = k; opt.textContent = lbl;
        if (current.type === k) opt.selected = true;
        kindSel.appendChild(opt);
    }

    const renderFields = (kind) => {
        fieldsHost.innerHTML = '';
        for (const fld of KIND_FIELDS[kind]) {
            const [name, label, type = 'number'] = fld;
            const row = document.createElement('label');
            row.className = 'ea-modal__row';
            row.innerHTML = `<span>${label}</span>`;
            const inp = document.createElement('input');
            inp.type = type;
            if (type === 'number') inp.step = 'any';
            inp.dataset.fld = name;
            const v = current[name];
            inp.value = (Array.isArray(v) ? v.join(', ')
                                          : (v == null ? '' : v));
            row.appendChild(inp);
            fieldsHost.appendChild(row);
        }
        if (kind === 'none') {
            const note = document.createElement('p');
            note.className = 'ea-modal__hint';
            note.textContent = "No randomness — every instance receives the param's Default value.";
            fieldsHost.appendChild(note);
        }
    };
    renderFields(current.type);
    kindSel.addEventListener('change', () => {
        current.type = kindSel.value;
        renderFields(current.type);
    });

    // openModal's action values are passed through. The Save handler
    // reads the live form before resolving so we get the typed values.
    const collect = () => {
        const out = { type: kindSel.value };
        for (const fld of KIND_FIELDS[kindSel.value]) {
            const [name, , type = 'number'] = fld;
            const inp = fieldsHost.querySelector(`[data-fld="${name}"]`);
            if (!inp) continue;
            if (type === 'text') {
                out[name] = inp.value
                    .split(',')
                    .map((v) => parseFloat(v.trim()))
                    .filter((v) => Number.isFinite(v));
            } else {
                const n = parseFloat(inp.value);
                if (Number.isFinite(n)) out[name] = n;
            }
        }
        return out;
    };

    // Stage the in-flight collected value so we can return it when
    // openModal resolves with the Save sentinel.
    let pending = null;
    const result = await openModal({
        title:   'Distribution',
        icon:    'tune',
        content,
        width:   480,
        height:  360,
        actions: [
            { label: 'Cancel', value: '__cancel__' },
            { label: 'Save',   value: '__save__', primary: true },
        ],
        onMount: () => {
            // Resolve Save with the *current* form values, not the
            // values at button-construction time.
            content.parentElement?.parentElement?.querySelector(
                '[data-action-idx]:last-child'
            )?.addEventListener('click', () => { pending = collect(); }, true);
        },
    });
    if (result === '__save__') return pending || collect();
    return undefined;
}


export function distSummary(dist) {
    if (!dist || !dist.type || dist.type === 'none') return 'Constant';
    const d = dist;
    const f = (n) => (n == null || Number.isNaN(n)) ? '?' : Number(n).toString();
    switch (d.type) {
        case 'uniform':    return `U(${f(d.min)}, ${f(d.max)})`;
        case 'normal':     return `N(${f(d.mean)}, ${f(d.stddev)})`;
        case 'lognormal':  return `LogN(${f(d.mu)}, ${f(d.sigma)})`;
        case 'triangular': return `Tri(${f(d.min)}, ${f(d.mode)}, ${f(d.max)})`;
        case 'beta':       return `Beta(${f(d.alpha)}, ${f(d.beta)})`;
        case 'discrete':   return `Discrete(${(d.values || []).length} vals)`;
        default:           return d.type;
    }
}
