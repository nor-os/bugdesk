/**
 * ticketdesk/select_field.js — BugDesk's form fields on FlexDesk's createSelect.
 *
 *     attachSelect(el, { options, value, onChange })
 *     attachSelect(el, { options, value, onChange, allowNew: true })   // Phase
 *
 * `el` is a control already in the DOM — typically the `<select>` or `<input>`
 * a form template rendered. It is REPLACED, and a hidden input with its
 * attributes carries the value, so `form.elements[name]`, `[data-f="…"]` lookups
 * and the submit path all keep working unchanged, and the masks' delegated
 * `change` listeners hear a pick as an ordinary field change. That is what lets
 * this drop into the existing masks without rewriting how they read their fields.
 *
 * An option is a string, or `{ value, label, icon, hint }`.
 */

import { createSelect } from '@flexdesk/widgets';

/**
 * Show or hide a form row.
 *
 * The `hidden` ATTRIBUTE alone is not enough: it only carries `display: none`
 * from the UA stylesheet, and any class rule with its own `display` beats it.
 * This codebase is full of them — `.td-field` is a grid, `.ea-modal__row` is a
 * grid — so `el.hidden = true` left the row on screen while every line of
 * JavaScript said it was hidden. An inline style wins over both; the attribute
 * stays for assistive tech.
 */
export function setRowVisible(el, on) {
    if (!el) return;
    el.hidden = !on;
    el.style.display = on ? '' : 'none';
}

/**
 * @param {HTMLElement} el   the control to replace (kept as the value carrier)
 * @param {object}   o
 * @param {Array}    o.options
 * @param {string}   [o.value]        initial value; defaults to `el.value`
 * @param {boolean}  [o.allowNew]     typing a value not in the list is allowed
 * @param {Function} [o.newLabel]     `(typed) => text` for that row; "Use “…”" by default
 * @param {string}   [o.emptyLabel]   what an empty value reads as
 * @param {Function} [o.onChange]     `(value) => void`, when the value changes
 * @param {Function} [o.optionsFor]   `() => options` — read at OPEN time, for a
 *                                    vocabulary that grows while the page lives
 * @returns {{ value(): string, set(v): void, isOpen(): boolean, destroy(): void, el: HTMLElement }}
 */
export function attachSelect(el, {
    options = [], value = null, allowNew = false,
    emptyLabel = '—', onChange = null, optionsFor = null, newLabel,
} = {}) {
    if (!el || !el.parentNode) return { value: () => '', set() {}, isOpen: () => false, destroy() {}, el };

    const carrier = document.createElement('input');
    for (const attr of el.attributes) carrier.setAttribute(attr.name, attr.value);
    carrier.removeAttribute('class');
    carrier.type = 'hidden';

    const select = createSelect({
        options: optionsFor || options,
        value: value != null ? String(value) : (el.value ?? ''),
        allowNew, newLabel, carrier,
        loose: true,
        placeholder: emptyLabel,
        className: 'bd-select',
        // BugDesk's own dialogs stand above FlexDesk's windows (ticketdesk.css).
        panelClassName: 'bd-select-panel',
        onChange: (v) => onChange?.(String(v ?? '')),
    });
    el.replaceWith(select.el);

    return {
        el: select.el,
        value: () => String(select.value ?? ''),
        set: (v) => { select.value = String(v ?? ''); },
        isOpen: () => select.isOpen,
        destroy: select.destroy,
    };
}

/**
 * Replace every `[data-f]` control in `host` that has a spec, in one call.
 * @param {HTMLElement} host
 * @param {object} specs  `{ fieldName: attachSelectOptions }`
 * @returns {object} the handles, keyed the same way
 */
export function attachSelects(host, specs) {
    const out = {};
    for (const [name, spec] of Object.entries(specs)) {
        const el = host.querySelector(`[data-f="${name}"]`);
        if (el) out[name] = attachSelect(el, spec);
    }
    return out;
}
