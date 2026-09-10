/**
 * ticketdesk/select_field.js — the choice control BugDesk uses instead of a
 * bare `<select>`.
 *
 * WHY NOT `<select>`: the browser draws it, so it ignores the app's tokens
 * entirely (a light popup over a dark UI on most platforms), it cannot show an
 * icon or a second line per option, and it cannot be typed into. Every one of
 * those matters here — Type wants a glyph per option, Assignee wants to say
 * which entries are agents, and Phase is a vocabulary the user extends by
 * typing a name that does not exist yet.
 *
 *     attachSelect(el, { options, value, onChange })
 *     attachSelect(el, { options, value, onChange, allowNew: true })   // Phase
 *
 * `el` is a control already in the DOM — typically the `<select>` or `<input>`
 * a form template rendered. It is REPLACED, and the original element is kept as
 * the value carrier so `form.elements[name]`, `[data-f="…"]` lookups and the
 * submit path all keep working unchanged. That is what lets this drop into the
 * existing masks without rewriting how they read their fields.
 *
 * An option is a string, or `{ value, label, icon, hint, group }`.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const norm = (o) => (typeof o === 'string' || typeof o === 'number')
    ? { value: String(o), label: String(o) }
    : { value: String(o?.value ?? o?.id ?? ''), label: String(o?.label ?? o?.value ?? o?.id ?? ''),
        icon: o?.icon || '', hint: o?.hint || '' };

/**
 * @param {HTMLElement} el   the control to replace (kept as the value carrier)
 * @param {object}   o
 * @param {Array}    o.options
 * @param {string}   [o.value]        initial value; defaults to `el.value`
 * @param {boolean}  [o.allowNew]     typing a value not in the list is allowed
 * @param {string}   [o.placeholder]
 * @param {string}   [o.emptyLabel]   what an empty value reads as
 * @param {Function} [o.onChange]     `(value) => void`
 * @param {Function} [o.optionsFor]   `() => options` — read at OPEN time, for a
 *                                    vocabulary that grows while the page lives
 * @returns {{ value(): string, set(v): void, destroy(): void, el: HTMLElement }}
 */
export function attachSelect(el, {
    options = [], value = null, allowNew = false, placeholder = 'Select…',
    emptyLabel = '—', onChange = null, optionsFor = null,
} = {}) {
    if (!el || !el.parentNode) return { value: () => '', set() {}, destroy() {}, el };

    // The carrier keeps the original name/id/data attributes so everything that
    // read this field before still reads it.
    const carrier = document.createElement('input');
    carrier.type = 'hidden';
    for (const attr of el.attributes) carrier.setAttribute(attr.name, attr.value);
    carrier.removeAttribute('class');
    carrier.type = 'hidden';
    let current = value != null ? String(value) : (el.value ?? '');
    carrier.value = current;

    const root = document.createElement('div');
    root.className = 'bd-sel';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bd-sel__button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    root.appendChild(button);

    el.replaceWith(root);
    root.appendChild(carrier);

    const list = () => (typeof optionsFor === 'function' ? optionsFor() : options).map(norm);

    const labelFor = (v) => {
        const hit = list().find((o) => o.value === v);
        if (hit) return hit;
        if (v) return { value: v, label: v };            // a value typed in earlier
        return { value: '', label: emptyLabel, muted: true };
    };

    const paint = () => {
        const o = labelFor(current);
        button.innerHTML = `
            ${o.icon ? `<span class="material-symbols-outlined bd-sel__icon">${esc(o.icon)}</span>` : ''}
            <span class="bd-sel__label${o.muted ? ' bd-sel__label--muted' : ''}">${esc(o.label)}</span>
            <span class="material-symbols-outlined bd-sel__caret">expand_more</span>`;
        button.title = o.label;
    };
    paint();

    /* ── the popup ───────────────────────────────────────────────────
     * Appended to <body>, not to the field: the field commonly lives inside a
     * scrolling mask or a modal with `overflow: hidden`, which would clip a
     * popup positioned inside it. Position is recomputed on open, and it closes
     * on scroll rather than trying to follow. */

    let panel = null;
    let cursor = 0;
    let filtered = [];

    const closePanel = () => {
        if (!panel) return;
        panel.remove();
        panel = null;
        button.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', closePanel, true);
        window.removeEventListener('resize', closePanel);
    };

    const commit = (v) => {
        current = String(v ?? '');
        carrier.value = current;
        paint();
        closePanel();
        // Fire on the carrier so existing delegated `change` listeners — the
        // masks all mark themselves dirty that way — see it as an ordinary
        // field change.
        carrier.dispatchEvent(new Event('change', { bubbles: true }));
        onChange?.(current);
    };

    const renderRows = (query) => {
        const q = query.trim().toLowerCase();
        const all = list();
        filtered = q ? all.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : all;
        cursor = Math.max(0, Math.min(cursor, filtered.length - 1));

        const rowsEl = panel.querySelector('.bd-sel__list');
        const typed = query.trim();
        const isNew = allowNew && typed && !all.some((o) => o.value.toLowerCase() === typed.toLowerCase());

        rowsEl.innerHTML = filtered.map((o, i) => `
            <li class="bd-sel__opt${i === cursor ? ' bd-sel__opt--on' : ''}${o.value === current ? ' bd-sel__opt--current' : ''}"
                role="option" aria-selected="${i === cursor}" data-value="${esc(o.value)}">
                ${o.icon ? `<span class="material-symbols-outlined bd-sel__icon">${esc(o.icon)}</span>` : '<span class="bd-sel__icon"></span>'}
                <span class="bd-sel__optlabel">${esc(o.label || emptyLabel)}</span>
                ${o.hint ? `<span class="bd-sel__hint">${esc(o.hint)}</span>` : ''}
            </li>`).join('')
            + (isNew
                ? `<li class="bd-sel__opt bd-sel__opt--new${filtered.length === 0 ? ' bd-sel__opt--on' : ''}"
                       role="option" data-new="${esc(typed)}">
                       <span class="material-symbols-outlined bd-sel__icon">add</span>
                       <span class="bd-sel__optlabel">Use “${esc(typed)}”</span>
                   </li>`
                : '')
            + (filtered.length === 0 && !isNew
                ? '<li class="bd-sel__empty">Nothing matches.</li>'
                : '');
        rowsEl.querySelector('.bd-sel__opt--on')?.scrollIntoView({ block: 'nearest' });
    };

    const onOutside = (e) => { if (panel && !panel.contains(e.target) && !root.contains(e.target)) closePanel(); };

    const onKey = (e) => {
        if (!panel) return;
        const input = panel.querySelector('.bd-sel__search');
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePanel(); button.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); cursor++; renderRows(input?.value ?? ''); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); cursor--; renderRows(input?.value ?? ''); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            const rows = panel.querySelectorAll('.bd-sel__opt');
            const row = panel.querySelector('.bd-sel__opt--on') || rows[0];
            if (row) commit(row.dataset.value ?? row.dataset.new ?? '');
        }
    };

    const openPanel = () => {
        if (panel) { closePanel(); return; }
        const all = list();
        // A search box only earns its place when there is something to search,
        // or when typing is how you add a value.
        const searchable = allowNew || all.length > 7;

        panel = document.createElement('div');
        panel.className = 'bd-sel__panel';
        panel.innerHTML = `
            ${searchable ? `<div class="bd-sel__searchrow">
                <span class="material-symbols-outlined">search</span>
                <input class="bd-sel__search" type="text" autocomplete="off"
                       placeholder="${esc(allowNew ? 'Search, or type a new one…' : 'Search…')}">
            </div>` : ''}
            <ul class="bd-sel__list" role="listbox"></ul>`;
        document.body.appendChild(panel);

        const rect = button.getBoundingClientRect();
        panel.style.minWidth = `${Math.max(rect.width, 180)}px`;
        panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8))}px`;
        // Flip above when there is no room below — a popup running off the
        // bottom of a modal is unreachable.
        const below = window.innerHeight - rect.bottom;
        if (below < panel.offsetHeight + 8 && rect.top > below) {
            panel.style.top = `${Math.max(8, rect.top - panel.offsetHeight - 2)}px`;
        } else {
            panel.style.top = `${rect.bottom + 2}px`;
        }

        cursor = Math.max(0, all.findIndex((o) => o.value === current));
        renderRows('');
        button.setAttribute('aria-expanded', 'true');

        panel.addEventListener('click', (e) => {
            const row = e.target.closest('[data-value],[data-new]');
            if (!row) return;
            commit(row.dataset.value ?? row.dataset.new ?? '');
        });
        const input = panel.querySelector('.bd-sel__search');
        input?.addEventListener('input', () => { cursor = 0; renderRows(input.value); });

        document.addEventListener('mousedown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', closePanel, true);
        window.addEventListener('resize', closePanel);

        requestAnimationFrame(() => (input || panel).focus?.());
    };

    button.addEventListener('click', openPanel);
    button.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel(); }
    });

    return {
        el: root,
        value: () => current,
        set: (v) => { current = String(v ?? ''); carrier.value = current; paint(); },
        destroy: () => { closePanel(); root.remove(); },
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
