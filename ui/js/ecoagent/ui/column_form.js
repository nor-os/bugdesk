/**
 * Small modal to add or edit a single schema column — name, type, and
 * nullable. Returns `{name, type, nullable}` on submit or `null` on
 * cancel. Used by the bottom-panel Schema view's per-column edit/add
 * affordances. The narrow type set mirrors `typed_inputs.js` /
 * `ecoagent/sim/typed_table.py`.
 */

import { ManagedWindow } from '../../ui/components/managed_window.js';
import { ESCAPE_HTML } from './typed_inputs.js';

let _seq = 0;

const TYPES = ['str', 'int', 'float', 'bool', 'tick', 'agent_id', 'json'];

/**
 * @param {Object} opts
 * @param {'add'|'edit'} [opts.mode]
 * @param {{name?:string,type?:string,nullable?:boolean}} [opts.column]
 * @param {string[]} [opts.existingNames]  other column names (dup check)
 * @param {boolean}  [opts.isPk]           edited column is the PK (name + type locked)
 * @returns {Promise<{name:string,type:string,nullable:boolean}|null>}
 */
export function openColumnForm(opts = {}) {
    const mode  = opts.mode || 'add';
    const col   = opts.column || {};
    const isEdit = mode === 'edit';
    const isPk  = !!opts.isPk;
    const others = (opts.existingNames || []).filter((n) => n !== col.name);
    const curType = col.type || 'str';
    const curNullable = col.nullable !== false;

    return new Promise((resolve) => {
        const body = document.createElement('div');
        body.className = 'ea-modal__body-host ea-col-form';
        body.innerHTML = `
            <form class="ea-col-form__form">
                <label class="ea-col-form__row">
                    <span class="ea-col-form__label">Name</span>
                    <input type="text" data-role="col-name" value="${ESCAPE_HTML(col.name || '')}"
                           ${isPk ? 'disabled' : ''} autocomplete="off" spellcheck="false">
                </label>
                <label class="ea-col-form__row">
                    <span class="ea-col-form__label">Type</span>
                    <select data-role="col-type" ${isPk ? 'disabled' : ''}>
                        ${TYPES.map((t) => `<option value="${t}" ${t === curType ? 'selected' : ''}>${t}</option>`).join('')}
                    </select>
                </label>
                <label class="ea-col-form__row ea-col-form__row--check">
                    <span class="ea-col-form__label">Nullable</span>
                    <input type="checkbox" data-role="col-nullable" ${curNullable ? 'checked' : ''}>
                </label>
                ${isPk ? '<div class="ea-modal__hint">Primary-key name and type are fixed (delete + add to re-key).</div>' : ''}
                <div class="ea-modal__error" data-role="form-error" hidden></div>
                <div class="ea-modal__actions">
                    <button type="button" class="ea-btn" data-action="cancel">Cancel</button>
                    <button type="submit" class="ea-btn ea-btn--primary">${isEdit ? 'Save' : 'Add column'}</button>
                </div>
            </form>
        `;

        const win = new ManagedWindow({
            id: `ea-col-form-${_seq++}`,
            title: isEdit ? `Edit column · ${col.name ?? ''}` : 'Add column',
            icon: isEdit ? 'edit' : 'add',
            content: body,
            modal: true,
            canMinimize: false, canMaximize: false, canResize: false, canDrag: true,
            defaultWidth: 380, defaultHeight: 260, minWidth: 320, minHeight: 220,
            onClose: () => { if (!resolved) { resolved = true; resolve(null); } },
        });
        win.show();

        let resolved = false;
        const close = (result) => {
            if (resolved) return;
            resolved = true;
            resolve(result);
            try { win.close({ force: true }); } catch { /* ignore */ }
        };

        const errEl = body.querySelector('[data-role="form-error"]');
        const showError = (m) => { errEl.textContent = m || ''; errEl.hidden = !m; };

        body.querySelector('[data-action="cancel"]')
            ?.addEventListener('click', () => close(null));

        body.querySelector('form')?.addEventListener('submit', (ev) => {
            ev.preventDefault();
            showError('');
            const name = String(body.querySelector('[data-role="col-name"]').value || '').trim();
            const type = String(body.querySelector('[data-role="col-type"]').value || 'str');
            const nullable = !!body.querySelector('[data-role="col-nullable"]').checked;
            if (!isPk) {
                if (!name) { showError('Name is required.'); return; }
                if (!/^[A-Za-z_]\w*$/.test(name)) {
                    showError('Name must start with a letter/underscore, then letters/digits/underscores.');
                    return;
                }
                if (others.includes(name)) { showError(`Column "${name}" already exists.`); return; }
            }
            close({ name: isPk ? (col.name || name) : name, type: isPk ? curType : type, nullable });
        });

        requestAnimationFrame(() => {
            body.querySelector('[data-role="col-name"]:not([disabled])')?.focus();
        });
    });
}
