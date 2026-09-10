/**
 * ticketdesk/item_picker.js — pick a backlog item by searching for it.
 *
 * A combobox over a datalist was the wrong control for choosing a parent: it
 * matches on the literal prefix of the option text, so finding "Auth rewrite"
 * meant typing "EPIC-0001" — the id you opened the picker to look up. This is a
 * search: type any part of a reference or title, filter by type, pick.
 *
 * The type filter is PRESELECTED to what can legally hold the thing being
 * parented — projects for an epic, epics and projects for a story — because
 * that is the answer nine times in ten, and it is still loosened with one click
 * rather than being a hard constraint the user has to fight. The rules
 * themselves live in ./backlog_data.js, next to the store they describe.
 *
 * Its own overlay rather than a ManagedWindow: it opens ON TOP of the New item
 * dialog, which is itself a modal, and it stacks in the same z-tier the filter
 * editor already established for exactly this reason (11000, above the
 * 6000–6999 ManagedWindow band).
 */

import { esc } from './data.js';
import {
    ALL_TYPES, ITEMS, TYPES, TYPE_ICON, TYPE_LABEL, childTypesFor, parentTypesFor, typeLabelOf,
} from './backlog_data.js';

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

/* The hierarchy rules live in ./backlog_data.js — `parentTypesFor` and
 * `childTypesFor` — beside the store they describe, and are re-exported here
 * because the picker is where most callers meet them. One definition: the same
 * two functions answer the picker's chips, the New item form's Parent row and
 * the item page's "add an existing child". */
export { childTypesFor, parentTypesFor };

/**
 * Open the picker.
 *
 * @param {object}   o
 * @param {string}   [o.title]      dialog title
 * @param {string[]} [o.types]      types selected in the filter on open
 * @param {number}   [o.exclude]    an id that cannot be picked (an item may not
 *                                  be its own parent)
 * @param {number[]} [o.excludeIds] ids that cannot be picked — an item's own
 *                                  descendants, which would make a cycle
 * @param {number}   [o.current]    the currently chosen id, highlighted
 * @returns {Promise<{id:number, ref:string, title:string}|null>} null on cancel.
 */
export function openItemPicker({
    title = 'Find an item', types = [], exclude = 0, excludeIds = [], current = 0,
} = {}) {
    const blocked = new Set([...(excludeIds || []), exclude].map(Number).filter(Boolean));

    /**
     * Which type chips to draw. The invariant: EVERY type that could be active
     * has a chip, so the filter is always something the user can undo.
     *
     * Three sources, and each one is a hole the others leave:
     *   - what this deployment offers (`TYPES`);
     *   - what is actually in the store — `TYPES` omits `project` outside
     *     tracker mode, and a chip set built from it alone would make a PROJ-
     *     record, written by whoever ran the same store as a tracker,
     *     permanently excluded here rather than merely unfiltered;
     *   - what the CALLER preselected — parenting an epic preselects `project`,
     *     and a preselected type with no chip is a dialog showing nothing with
     *     no control that explains why or lets you widen it.
     */
    const chipTypes = ALL_TYPES.filter((t) => TYPES.includes(t)
        || types.includes(t)
        || ITEMS.some((i) => i.type === t));

    return new Promise((resolve) => {
        const active = new Set(types.length ? types : chipTypes);
        let query = '';
        let cursor = 0;                 // index into the rendered result list
        let results = [];

        const overlay = document.createElement('div');
        overlay.className = 'bd-picker';
        overlay.innerHTML = `
            <div class="bd-picker__dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
                <div class="bd-picker__head">
                    ${icon('search')}
                    <input class="bd-picker__input" type="text" autocomplete="off"
                           placeholder="Search by reference or title…" aria-label="Search">
                    <button type="button" class="bd-picker__close" data-a="cancel"
                            aria-label="Cancel">${icon('close')}</button>
                </div>
                <div class="bd-picker__filters" role="group" aria-label="Filter by type">
                    ${chipTypes.map((t) => `
                        <button type="button" class="bd-picker__chip${active.has(t) ? ' bd-picker__chip--on' : ''}"
                                data-type="${t}" aria-pressed="${active.has(t)}">
                            ${icon(TYPE_ICON[t])}${esc(typeLabelOf(t))}
                        </button>`).join('')}
                    <span class="bd-picker__count" data-slot="count"></span>
                </div>
                <ul class="bd-picker__list" data-slot="list" role="listbox"></ul>
                <div class="bd-picker__foot">
                    <button type="button" class="ea-btn" data-a="clear">Leave empty</button>
                    <span class="td-spacer"></span>
                    <button type="button" class="ea-btn" data-a="cancel">Cancel</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const input = overlay.querySelector('.bd-picker__input');
        const listEl = overlay.querySelector('[data-slot="list"]');
        const countEl = overlay.querySelector('[data-slot="count"]');
        const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        let settled = false;
        const close = (value) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            try { returnFocus?.focus(); } catch { /* gone */ }
            resolve(value);
        };

        const matches = () => {
            const q = query.trim().toLowerCase();
            return ITEMS.filter((i) => {
                if (!active.has(i.type)) return false;
                if (blocked.has(Number(i.id))) return false;
                if (!q) return true;
                return i.ref.toLowerCase().includes(q) || String(i.title || '').toLowerCase().includes(q);
            });
        };

        const render = () => {
            results = matches();
            cursor = Math.max(0, Math.min(cursor, results.length - 1));
            countEl.textContent = `${results.length} item${results.length === 1 ? '' : 's'}`;
            listEl.innerHTML = results.length
                ? results.map((i, n) => `
                    <li class="bd-picker__row${n === cursor ? ' bd-picker__row--on' : ''}${
                        Number(i.id) === Number(current) ? ' bd-picker__row--current' : ''}"
                        role="option" aria-selected="${n === cursor}" data-pick="${i.id}">
                        <span class="bd-type bd-type--${i.type}">${icon(TYPE_ICON[i.type])}</span>
                        <span class="bd-picker__ref">${esc(i.ref)}</span>
                        <span class="bd-picker__title">${esc(i.title)}</span>
                        <span class="bd-picker__meta">${esc(i.phaseLabel || '')}</span>
                    </li>`).join('')
                : `<li class="bd-picker__empty">${query.trim()
                    ? 'Nothing matches that.'
                    : 'No items of the selected types.'}</li>`;
            listEl.querySelector('.bd-picker__row--on')?.scrollIntoView({ block: 'nearest' });
        };
        render();

        const pick = (id) => {
            const item = ITEMS.find((i) => Number(i.id) === Number(id));
            close(item ? { id: Number(item.id), ref: item.ref, title: item.title } : null);
        };

        input.addEventListener('input', () => { query = input.value; cursor = 0; render(); });

        overlay.addEventListener('click', (e) => {
            // Clicking the backdrop cancels; clicking the dialog must not.
            if (e.target === overlay) { close(null); return; }
            const chip = e.target.closest('[data-type]');
            if (chip) {
                const t = chip.dataset.type;
                if (active.has(t)) active.delete(t); else active.add(t);
                // Never leave every type off — an empty filter shows nothing and
                // reads as a broken dialog rather than a deliberate one.
                if (active.size === 0) active.add(t);
                chip.classList.toggle('bd-picker__chip--on', active.has(t));
                chip.setAttribute('aria-pressed', String(active.has(t)));
                cursor = 0;
                render();
                return;
            }
            const row = e.target.closest('[data-pick]');
            if (row) { pick(row.dataset.pick); return; }
            const act = e.target.closest('[data-a]')?.dataset.a;
            if (act === 'cancel') close(null);
            // "Leave empty" is a CHOICE, distinct from cancelling: it clears the
            // field rather than leaving whatever was there.
            else if (act === 'clear') close({ id: 0, ref: '', title: '' });
        });

        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); cursor++; render(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); cursor--; render(); }
            else if (e.key === 'Enter') {
                e.preventDefault();
                if (results[cursor]) pick(results[cursor].id);
            }
        };
        // Capture: the New item dialog underneath has its own Escape handler,
        // and the topmost overlay is the one that should answer for it.
        document.addEventListener('keydown', onKey, true);

        requestAnimationFrame(() => input.focus());
    });
}

/**
 * The PARENT CONTROL: a read-only display of the current parent plus a search
 * button that opens the picker above.
 *
 * ONE implementation, used by the New item page and by the item detail page —
 * changing an item's parent is the same act whether the item exists yet or not,
 * and a second copy would be a second set of rules about which types may hold
 * which.
 *
 * `el` is replaced, and its attributes move onto a hidden carrier holding the
 * parent ID, so `[data-f="parent"]` reads keep working.
 *
 * @param {HTMLElement} el
 * @param {object}   o
 * @param {() => string} o.typeOf     the CHILD's type, read at click time (the
 *                                    type select can change after this is built)
 * @param {number}   [o.value]        current parent id
 * @param {() => number} [o.excludeId] an item cannot be its own parent
 * @param {Function} [o.onChange]     `(id) => void`
 * @returns {{ value(): number, set(id): void, destroy(): void }}
 */
export function attachParentPicker(el, { typeOf, value = 0, excludeId = null, onChange = null } = {}) {
    if (!el || !el.parentNode) return { value: () => 0, set() {}, destroy() {} };

    let current = Number(value) || 0;

    const carrier = document.createElement('input');
    carrier.type = 'hidden';
    for (const attr of el.attributes) carrier.setAttribute(attr.name, attr.value);
    carrier.removeAttribute('class');
    carrier.type = 'hidden';
    carrier.value = current ? String(current) : '';

    const root = document.createElement('div');
    root.className = 'ea-picker';
    root.innerHTML = `
        <input class="ea-tin ea-picker__display" type="text" readonly
               placeholder="none — click to search">
        <button type="button" class="ea-btn ea-picker__btn" aria-label="Find a parent">
            <span class="material-symbols-outlined">search</span>
        </button>
        <button type="button" class="ea-btn ea-picker__clear" aria-label="Clear parent" hidden>
            <span class="material-symbols-outlined">close</span>
        </button>`;
    el.replaceWith(root);
    root.appendChild(carrier);

    const display = root.querySelector('.ea-picker__display');
    const clearBtn = root.querySelector('.ea-picker__clear');

    const paint = () => {
        const item = ITEMS.find((i) => Number(i.id) === current);
        display.value = item ? `${item.ref} — ${item.title}` : '';
        clearBtn.hidden = !current;
    };
    paint();

    const commit = (id) => {
        current = Number(id) || 0;
        carrier.value = current ? String(current) : '';
        paint();
        carrier.dispatchEvent(new Event('change', { bubbles: true }));
        onChange?.(current);
    };

    const open = async () => {
        const childType = typeOf?.() || 'task';
        const picked = await openItemPicker({
            title: `Parent for this ${(TYPE_LABEL[childType] || 'item').toLowerCase()}`,
            types: parentTypesFor(childType),
            current,
            exclude: excludeId?.() || 0,
        });
        if (!picked) return;
        commit(picked.id);
    };

    const onClick = (e) => {
        if (e.target.closest('.ea-picker__clear')) { commit(0); return; }
        if (e.target.closest('.ea-picker__btn') || e.target === display) open();
    };
    root.addEventListener('click', onClick);

    return {
        value: () => current,
        set: (id) => commit(id),
        destroy: () => { root.removeEventListener('click', onClick); root.remove(); },
    };
}

