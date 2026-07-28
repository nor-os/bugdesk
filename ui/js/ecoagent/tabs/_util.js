/**
 * _util.js — tiny shared helpers for the tab-content providers.
 */

export function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

/** SFC-style amount formatter — '·' for ~zero, '—' for non-numeric. */
export function fmt(v) {
    if (v == null) return '—';
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (Math.abs(v) < 1e-6) return '·';
    return v.toFixed(2);
}

/** Population-table style number formatter — trims trailing zeros. */
export function fmtNum(v) {
    if (v == null) return '—';
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return '—';
        return Number(v.toFixed(4)).toString();
    }
    return esc(String(v));
}

/**
 * Mount a standard EcoAgent tab shell into `host`.
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ TITLE                  [badges]            [⋯ actions] │  ← 24px strip
 *   ├──────────────────────────────────────────────────────┤
 *   │ body                                                  │  ← consumer-owned
 *   └──────────────────────────────────────────────────────┘
 *
 * One header style for every workspace tab — flow / scenario /
 * sector / agent / market / project-setup / dashboard. Title is
 * 12px uppercase (not an `<h2>`), action buttons are icon-only
 * with tooltip text. Drops the per-tab `.ea-detail-header` shells
 * which were drifting in padding / title sizing.
 *
 * @param {HTMLElement} host
 * @param {object} opts
 *   - `title`       : string — main label (mandatory)
 *   - `subtitle`    : string — small dim text under or next to title
 *   - `badges`      : Array<{label, variant?}> — inline pills
 *   - `actions`     : Array<{icon, tooltip, onClick, dataset?}> — right-side icon buttons
 *   - `titleControl`: HTMLElement — optional editable-title widget to use instead of plain text
 *
 * Returns `{ headerEl, bodyEl, setSubtitle(s), setTitle(s) }`. The
 * caller stuffs content into `bodyEl`.
 */
export function mountTabShell(host, opts = {}) {
    host.innerHTML = `
        <div class="ea-tab-shell">
            <header class="ea-tab-shell__head">
                <div class="ea-tab-shell__title-slot" data-role="title"></div>
                <span class="ea-tab-shell__sub" data-role="sub"></span>
                <span class="ea-tab-shell__badges" data-role="badges"></span>
                <span class="ea-tab-shell__spacer"></span>
                <span class="ea-tab-shell__actions" data-role="actions"></span>
            </header>
            <div class="ea-tab-shell__body" data-role="body"></div>
        </div>
    `;
    const titleEl   = host.querySelector('[data-role="title"]');
    const subEl     = host.querySelector('[data-role="sub"]');
    const badgesEl  = host.querySelector('[data-role="badges"]');
    const actionsEl = host.querySelector('[data-role="actions"]');
    const bodyEl    = host.querySelector('[data-role="body"]');

    if (opts.titleControl) {
        titleEl.appendChild(opts.titleControl);
    } else if (opts.title != null) {
        titleEl.innerHTML = `<span class="ea-tab-shell__title">${esc(opts.title)}</span>`;
    }
    if (opts.subtitle) subEl.textContent = String(opts.subtitle);
    for (const b of (opts.badges || [])) {
        const span = document.createElement('span');
        span.className = `ea-badge${b.variant ? ' ea-badge--' + b.variant : ''}`;
        span.textContent = b.label;
        badgesEl.appendChild(span);
    }
    for (const a of (opts.actions || [])) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ea-tab-shell__action has-tooltip';
        if (a.tooltip) {
            btn.dataset.tooltip = a.tooltip;
            btn.dataset.tooltipPlacement = 'bottom';
            btn.title = a.tooltip;
        }
        if (a.dataset) for (const [k, v] of Object.entries(a.dataset)) btn.dataset[k] = v;
        btn.innerHTML = `<span class="material-symbols-outlined">${a.icon}</span>`;
        if (a.onClick) btn.addEventListener('click', a.onClick);
        actionsEl.appendChild(btn);
    }

    return {
        headerEl: host.querySelector('.ea-tab-shell__head'),
        bodyEl,
        setSubtitle(s) { subEl.textContent = String(s || ''); },
        setTitle(s) {
            const t = titleEl.querySelector('.ea-tab-shell__title');
            if (t) t.textContent = String(s || '');
        },
    };
}


/**
 * Mount a "click-to-edit" title into `el` — display-only by default,
 * with two explicit affordances to enter edit mode:
 *   1. **Double-click** on the title text
 *   2. **Click the pencil button** that sits next to the title
 *
 * Commit on Enter or blur; revert on Escape. Replaces the
 * always-editable `<input>` pattern (which leaked into the page and
 * made every focus look like an edit). Consistent treatment across
 * every entity-name surface: flows, sectors, agents, scenarios, …
 *
 * @param {HTMLElement} el  — the element to render the title into
 * @param {object} opts
 *   - `value`     : string — initial value
 *   - `placeholder`: string — shown when value is empty
 *   - `onCommit`  : (newValue: string) => void | Promise<void>
 *   - `tag`       : 'h2' | 'span' (default 'h2') — wrapper element
 *   - `className` : string — extra class for the wrapper (CSS hook)
 *
 * Returns a `dispose()` function and a `setValue(s)` for callers
 * that re-render the title from external sources.
 */
export function mountEditableTitle(el, opts = {}) {
    const tag = opts.tag || 'h2';
    const placeholder = opts.placeholder || 'Untitled';
    const onCommit = opts.onCommit || (() => {});
    let value = String(opts.value || '');
    let editing = false;
    let input = null;

    const render = () => {
        const cls = ['ea-edit-title'];
        if (opts.className) cls.push(opts.className);
        const shown = value || placeholder;
        const mutedClass = value ? '' : ' ea-edit-title__text--empty';
        el.innerHTML = `
            <${tag} class="${cls.join(' ')}">
                <span class="ea-edit-title__text${mutedClass}"
                      data-role="display">${esc(shown)}</span>
                <button type="button" class="ea-edit-title__btn"
                        data-role="edit-btn"
                        title="Rename (Enter to commit, Esc to cancel)">
                    <span class="material-symbols-outlined">edit</span>
                </button>
            </${tag}>
        `;
        const display = el.querySelector('[data-role="display"]');
        const btn = el.querySelector('[data-role="edit-btn"]');
        display.addEventListener('dblclick', enterEdit);
        btn.addEventListener('click', enterEdit);
    };

    const enterEdit = () => {
        if (editing) return;
        editing = true;
        // Swap the display span for an inline input pre-populated with
        // the current value. Use the same wrapper tag so the layout
        // doesn't shift.
        el.innerHTML = `
            <${tag} class="ea-edit-title ea-edit-title--editing${opts.className ? ' ' + opts.className : ''}">
                <input type="text"
                       class="ea-edit-title__input"
                       value="${esc(value)}"
                       placeholder="${esc(placeholder)}"
                       data-role="input">
            </${tag}>
        `;
        input = el.querySelector('[data-role="input"]');
        input.focus();
        input.select();
        input.addEventListener('keydown', onKey);
        input.addEventListener('blur', commit);
    };

    const commit = async () => {
        if (!editing || !input) return;
        const next = input.value.trim();
        editing = false;
        input.removeEventListener('keydown', onKey);
        input.removeEventListener('blur', commit);
        input = null;
        if (next !== value) {
            value = next;
            try { await onCommit(value); } catch { /* caller handles errors */ }
        }
        render();
    };

    const cancel = () => {
        if (!editing || !input) return;
        editing = false;
        input.removeEventListener('keydown', onKey);
        input.removeEventListener('blur', commit);
        input = null;
        render();
    };

    const onKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };

    render();

    return {
        dispose() { /* no global listeners — render() rebuilds DOM */ },
        setValue(v) {
            if (editing) return;          // don't clobber an active edit
            value = String(v || '');
            render();
        },
        getValue() { return value; },
    };
}
