/**
 * ticketdesk/page_bar.js — the Discard / Save bar of a project editor drawn on
 * the Settings page (Record types, Workflow, Team, Alerts).
 *
 * It sits in the page header, on the title's line (settings_page.js hands each
 * panel that header slot as `actions`), so it is in the same place on every
 * page. Without a slot — the editor mounted somewhere else — it goes at the
 * top of `host`.
 *
 * The frame around the editor is shared too: `projectFoot()` is the line under
 * it saying where the change is saved.
 */

/**
 * @param {HTMLElement|null} actions  the page header's slot, if there is one
 * @param {HTMLElement} host          where it goes otherwise (first child)
 * @param {(act: 'discard'|'save') => void} onAct
 */
export function pageBar(actions, host, onAct) {
    const el = document.createElement('div');
    el.className = 'bd-pagebar';
    el.innerHTML = `
        <span class="bd-pagebar__state" data-slot="state" aria-live="polite"></span>
        <button type="button" class="ea-btn" data-act="discard" disabled>Discard changes</button>
        <button type="button" class="ea-btn ea-btn--primary" data-act="save" disabled>Save</button>`;
    if (actions) actions.replaceChildren(el);
    else host.prepend(el);
    el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (b && !b.disabled) onAct(b.dataset.act);
    });
    const state = el.querySelector('.bd-pagebar__state');
    return {
        el,
        /** A `note` (a problem, a notice) replaces "Unsaved changes"; the buttons follow `dirty`. */
        sync({ dirty = false, busy = false, note = '' } = {}) {
            state.textContent = note || (dirty ? 'Unsaved changes' : '');
            state.classList.toggle('is-dirty', !note && dirty);
            for (const b of el.querySelectorAll('button')) b.disabled = busy || !dirty;
        },
        remove: () => el.remove(),
    };
}

/** The line under a project editor: where its changes go. */
export const projectFoot = (extra = '') => `
    <div class="bd-proj__foot"><span class="material-symbols-outlined">description</span>
        <span>Saved to <code>.bugdesk/project.json</code>. Commit it to share it.${extra ? ` ${extra}` : ''}</span></div>`;
