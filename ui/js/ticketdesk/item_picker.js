/**
 * ticketdesk/item_picker.js — pick a record by searching for it.
 *
 * A combobox over a datalist was the wrong control for choosing a parent: it
 * matches on the literal prefix of the option text, so finding "Auth rewrite"
 * meant typing "EPIC-0001" — the id you opened the picker to look up. This is a
 * search: type any part of a reference or title, filter, pick.
 *
 * "RECORD" HERE MEANS A ROW IN EITHER STORE. The backlog is the default because
 * that is what every existing caller wants; a caller that can legitimately point
 * at a bug — linking, marking a duplicate — opts in with `stores`.
 *
 * FINISHED WORK IS HIDDEN until the Closed chip is ticked. A store accumulates
 * closed records forever — after a year they are most of it — and a picker is a
 * place you go to find something to act on. The count says how many were held
 * back, so the chip is discoverable at the moment it would help.
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
    ALL_TYPES, ITEMS, TYPES, TYPE_ICON, TYPE_LABEL,
    childTypesFor, parentTypesFor, typeLabelOf,
} from './backlog_data.js';
import { allRows, findRow, storesAvailable } from './records.js';
import { formatRef, parseKey, parseRef, refKey, sameRef } from './refs.js';
import { attachSelect } from './select_field.js';

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

const STORE_LABEL = { bugs: 'Bugs', backlog: 'Backlog' };

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
 * @param {string[]} [o.stores]     which stores may be searched
 * @param {string[]} [o.types]      types selected in the filter on open —
 *                                  backlog types, and only when one store is
 *                                  offered
 * @param {number|object} [o.exclude]    a record that cannot be picked (an item
 *                                       may not be its own parent)
 * @param {Array<number|object>} [o.excludeIds] records that cannot be picked —
 *                                  an item's own descendants, which would make
 *                                  a cycle
 * @param {number|object} [o.current]    the currently chosen record, highlighted
 * @returns {Promise<{store:string, id:number, ref:string, title:string, type:string,
 *                    prefix:string, target:object|null}|null>} null on cancel.
 */
export function openRecordPicker({
    title = 'Find a record', stores = ['backlog'], types = [],
    exclude = 0, excludeIds = [], current = 0,
} = {}) {
    // Tracker mode has no bug store at all, so a caller asking for both degrades
    // to backlog-only rather than drawing a Bugs chip whose targets cannot exist.
    const asked = (stores || []).filter((s) => storesAvailable().includes(s));
    const offered = asked.length ? asked : ['backlog'];
    const multiStore = offered.length > 1;

    /** The three id inputs are bare BACKLOG ids in every existing caller, and a
     *  Ref in every new one. `parseRef` against the backlog is the same answer
     *  for a number as a hand-written normaliser would give, and it additionally
     *  accepts a token, so there is one spelling of "what did the caller mean". */
    const asRef = (v) => ((v && typeof v === 'object') ? v : parseRef(v, 'backlog'));
    const blocked = new Set([...(excludeIds || []), exclude].map(asRef).map(refKey).filter(Boolean));
    const currentRef = asRef(current);

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
        const activeStores = new Set(offered);
        // Finished work is hidden until asked for. A picker is a place you go to
        // find something to ACT on, and a store accumulates closed records
        // forever — after a year they are most of it, and they push the three
        // live ones you were looking for off the screen.
        let includeClosed = false;
        let query = '';
        let cursor = 0;                 // index into the rendered result list
        let results = [];

        /* A store dimension ABOVE the type dimension, never both: the two type
         * enums cannot be unioned — `task` is a backlog task and, via
         * `TYPE_MACHINE` in data.js, a Chore bug — and a cross-store pick is a
         * search, not a taxonomy walk. */
        const chipsHTML = multiStore
            ? offered.map((s) => `
                        <button type="button" class="bd-picker__chip bd-picker__chip--on"
                                data-store="${s}" aria-pressed="true">
                            ${esc(STORE_LABEL[s] || s)}
                        </button>`).join('')
            : chipTypes.map((t) => `
                        <button type="button" class="bd-picker__chip${active.has(t) ? ' bd-picker__chip--on' : ''}"
                                data-type="${t}" aria-pressed="${active.has(t)}">
                            ${icon(TYPE_ICON[t])}${esc(typeLabelOf(t))}
                        </button>`).join('');

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
                <div class="bd-picker__filters" role="group"
                     aria-label="Filter by ${multiStore ? 'store' : 'type'}">
                    ${chipsHTML}
                    <span class="td-spacer"></span>
                    <button type="button" class="bd-picker__chip bd-picker__chip--closed"
                            data-closed="1" aria-pressed="false"
                            title="Finished work is hidden by default">
                        ${icon('check_circle')}Closed
                    </button>
                    <span class="bd-picker__count" data-slot="count"></span>
                </div>
                <div class="bd-picker__filters bd-picker__filters--more" role="group" aria-label="More filters">
                    ${multiStore ? '<span class="bd-picker__facet"><label>Type</label><select data-facet="type"></select></span>' : ''}
                    <span class="bd-picker__facet"><label>Status</label><select data-facet="status"></select></span>
                    <span class="bd-picker__facet"><label>Assignee</label><select data-facet="assignee"></select></span>
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
            for (const f of facetSelects) { try { f.destroy(); } catch { /* gone */ } }
            overlay.remove();
            try { returnFocus?.focus(); } catch { /* gone */ }
            resolve(value);
        };

        /* Every candidate, filter, render and pick path reads ROWS, not a store
         * array: `Row` is the one shape a bug and an item share, so none of them
         * has to know which store the thing under the cursor came from. */
        const rows = () => allRows(offered);

        /* THE FACETS — type, status, assignee — the same questions the filter
         * editor asks of a list, narrowed to what a picker needs. Each is a
         * custom dropdown whose options are the values actually present, so
         * nothing offered can match zero rows by construction. Empty = any.
         * The type facet only exists across stores: within one store the type
         * chips already answer it. A type is keyed with its store, because
         * `task` is a backlog task in one and a Chore bug in the other. */
        const facets = { type: '', status: '', assignee: '' };
        const facetOf = {
            type: (row) => `${row.store}:${row.type}`,
            status: (row) => String(row.status || ''),
            assignee: (row) => String(row.record?.assignee || ''),
        };
        const facetOptions = (name) => {
            const seen = new Map();
            for (const row of rows()) {
                if (multiStore && !activeStores.has(row.store)) continue;
                const v = facetOf[name](row);
                if (!v || seen.has(v)) continue;
                seen.set(v, name === 'type'
                    ? { value: v, label: row.typeLabel || row.type, hint: STORE_LABEL[row.store] || row.store,
                        icon: row.store === 'bugs' ? 'bug_report' : TYPE_ICON[row.type] }
                    : { value: v, label: v });
            }
            return [{ value: '', label: 'Any' },
                ...[...seen.values()].sort((a, b) => a.label.localeCompare(b.label))];
        };

        /** Rows of the right kind, not blocked, matching the query. `closed`
         *  is applied separately so the count can say how many it removed. */
        const candidates = () => {
            const q = query.trim().toLowerCase();
            return rows().filter((row) => {
                if (multiStore) { if (!activeStores.has(row.store)) return false; }
                else if (!active.has(row.type)) return false;
                if (blocked.has(row.key)) return false;
                for (const name of Object.keys(facets)) {
                    if (facets[name] && facetOf[name](row) !== facets[name]) return false;
                }
                if (!q) return true;
                // Ref OR title. Searching by title is the primary way a master
                // is found in "what is #42 a duplicate of?" — a reference match
                // alone would never hit a word the user actually remembers.
                return row.label.toLowerCase().includes(q)
                    || String(row.title || '').toLowerCase().includes(q);
            });
        };

        // The record ALREADY chosen is never hidden, whatever its status: a
        // picker that cannot show you what the field currently holds is a
        // picker that makes the field look empty.
        const hidden = (row) => row.closed && !sameRef(row.ref, currentRef);

        const matches = () => {
            const all = candidates();
            return includeClosed ? all : all.filter((row) => !hidden(row));
        };

        const render = () => {
            results = matches();
            cursor = Math.max(0, Math.min(cursor, results.length - 1));
            // Say how many were held back, so the chip is discoverable at the
            // moment it would help rather than being a control nobody notices.
            const held = includeClosed ? 0 : candidates().filter(hidden).length;
            countEl.textContent = `${results.length} item${results.length === 1 ? '' : 's'}`
                + (held ? ` · ${held} closed hidden` : '');
            listEl.innerHTML = results.length
                ? results.map((row, n) => `
                    <li class="bd-picker__row${n === cursor ? ' bd-picker__row--on' : ''}${
                        sameRef(row.ref, currentRef) ? ' bd-picker__row--current' : ''}"
                        role="option" aria-selected="${n === cursor}" data-pick="${row.key}">
                        <span class="bd-type bd-type--${row.store === 'bugs' ? 'bug' : row.type}">${icon(row.icon)}</span>
                        <span class="bd-picker__ref">${esc(row.label)}</span>
                        <span class="bd-picker__title">${esc(row.title)}</span>
                        <span class="bd-picker__meta">${esc(row.meta)}</span>
                    </li>`).join('')
                : `<li class="bd-picker__empty">${
                    (!includeClosed && candidates().some(hidden))
                        ? 'Nothing open matches that — try Closed.'
                        : query.trim() ? 'Nothing matches that.'
                        : multiStore ? 'Nothing in the selected stores.'
                        : 'No items of the selected types.'}</li>`;
            listEl.querySelector('.bd-picker__row--on')?.scrollIntoView({ block: 'nearest' });
        };
        render();

        const facetSelects = [...overlay.querySelectorAll('[data-facet]')].map((el) => {
            const name = el.dataset.facet;
            return attachSelect(el, {
                value: '', emptyLabel: 'Any',
                optionsFor: () => facetOptions(name),
                onChange: (v) => { facets[name] = v; cursor = 0; render(); },
            });
        });

        // The DOM carries the row's IDENTITY, not its index: `refKey` survives a
        // re-render, a store reload and a row that moved, and it is the same key
        // every other cross-store reference resolves through.
        const pick = (key) => {
            const row = findRow(parseKey(key));
            close(row ? {
                store: row.store,
                id: row.id,
                ref: row.label,
                title: row.title,
                type: row.type,
                prefix: row.ref.prefix,
                target: row.ref,
            } : null);
        };

        input.addEventListener('input', () => { query = input.value; cursor = 0; render(); });

        overlay.addEventListener('click', (e) => {
            // Clicking the backdrop cancels; clicking the dialog must not.
            if (e.target === overlay) { close(null); return; }
            const closedChip = e.target.closest('[data-closed]');
            if (closedChip) {
                includeClosed = !includeClosed;
                closedChip.classList.toggle('bd-picker__chip--on', includeClosed);
                closedChip.setAttribute('aria-pressed', String(includeClosed));
                cursor = 0;
                render();
                return;
            }
            const storeChip = e.target.closest('[data-store]');
            if (storeChip) {
                const s = storeChip.dataset.store;
                if (activeStores.has(s)) activeStores.delete(s); else activeStores.add(s);
                // Never leave every store off, for the same reason as the types
                // below: an empty filter shows nothing and reads as a broken
                // dialog rather than a deliberate one.
                if (activeStores.size === 0) activeStores.add(s);
                storeChip.classList.toggle('bd-picker__chip--on', activeStores.has(s));
                storeChip.setAttribute('aria-pressed', String(activeStores.has(s)));
                cursor = 0;
                render();
                return;
            }
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
            else if (act === 'clear') {
                close({ store: 'backlog', id: 0, ref: '', title: '', type: '', prefix: '', target: null });
            }
        });

        const onKey = (e) => {
            // A facet dropdown that is open answers its own keys (select_field.js).
            if (document.querySelector('.bd-sel__panel')) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); cursor++; render(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); cursor--; render(); }
            else if (e.key === 'Enter') {
                e.preventDefault();
                if (results[cursor]) pick(results[cursor].key);
            }
        };
        // Capture: the New item dialog underneath has its own Escape handler,
        // and the topmost overlay is the one that should answer for it.
        document.addEventListener('keydown', onKey, true);

        requestAnimationFrame(() => input.focus());
    });
}

/**
 * The backlog-only picker — every caller that parents, attaches a child or
 * navigates the item tree, none of which a bug can take part in.
 *
 * @param {object} [o] as `openRecordPicker`, minus `stores`
 */
export const openItemPicker = (o = {}) => openRecordPicker({ ...o, stores: ['backlog'] });

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

/**
 * THE LINK TARGET FIELD, SEARCHABLE IN PLACE (BUG-0011). Typing into it lists
 * the records whose reference or title match, right under the field; ↑/↓ move,
 * Enter or a click puts the record's reference in the field. The field stays an
 * ordinary text input — a typed `#42` or `STORY-7` still goes through the same
 * parser on Link — so this is a second way in, not a second set of rules. The
 * magnifier beside it is still the full search, with filters.
 *
 * Open records come first; closed ones follow, dimmed, because linking to a
 * finished record is legitimate ("caused-by #12") but rarely the one meant.
 *
 * @param {HTMLInputElement} input
 * @param {object}   o
 * @param {string[]} o.stores        which stores to search
 * @param {string}   o.selfStore     how a picked ref is written (`bugs`/`backlog`)
 * @param {() => object|null} [o.exclude] the record's own ref — not offered
 * @param {() => void} [o.onEnter]   Enter with no list open (i.e. "Link")
 * @returns {{ destroy(): void }}
 */
export function attachRecordTypeahead(input, { stores, selfStore, exclude = null, onEnter = null, limit = 8 }) {
    if (!input) return { destroy() {} };
    let panel = null;
    let results = [];
    let cursor = 0;

    const close = () => {
        panel?.remove();
        panel = null;
        window.removeEventListener('scroll', onScroll, true);
    };
    const onScroll = (e) => { if (!panel?.contains(e.target)) close(); };

    const search = () => {
        const q = input.value.trim().toLowerCase();
        if (!q) return [];
        const self = exclude?.();
        const selfKey = self ? refKey(self) : null;
        const hits = allRows(stores.filter((st) => storesAvailable().includes(st))).filter((row) =>
            row.key !== selfKey
            && (row.label.toLowerCase().includes(q) || String(row.title || '').toLowerCase().includes(q)));
        // Open before closed; within each, a reference that STARTS with what was
        // typed before a title that merely contains it.
        const rank = (row) => (row.closed ? 2 : 0) + (row.label.toLowerCase().startsWith(q) ? 0 : 1);
        return hits.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
    };

    const paint = () => {
        if (!results.length) { close(); return; }
        if (!panel) {
            panel = document.createElement('div');
            panel.className = 'bd-sel__panel bd-typeahead';
            panel.innerHTML = '<ul class="bd-sel__list" role="listbox"></ul>';
            document.body.appendChild(panel);
            window.addEventListener('scroll', onScroll, true);
            // mousedown, not click: a click lands after the input's blur closed us.
            panel.addEventListener('mousedown', (e) => {
                const li = e.target.closest('[data-pick]');
                if (!li) return;
                e.preventDefault();
                pick(Number(li.dataset.pick));
            });
        }
        const r = input.getBoundingClientRect();
        Object.assign(panel.style, { left: `${r.left}px`, top: `${r.bottom + 2}px`, minWidth: `${Math.max(r.width, 320)}px` });
        panel.querySelector('ul').innerHTML = results.map((row, n) => `
            <li class="bd-sel__opt${n === cursor ? ' bd-sel__opt--on' : ''}${row.closed ? ' bd-typeahead__closed' : ''}"
                role="option" aria-selected="${n === cursor}" data-pick="${n}">
                <span class="material-symbols-outlined bd-sel__icon">${esc(row.icon)}</span>
                <span class="bd-sel__optlabel"><b class="td-mono">${esc(row.label)}</b> ${esc(row.title)}</span>
                <span class="bd-sel__hint">${esc(row.status)}</span>
            </li>`).join('');
    };

    const pick = (n) => {
        const row = results[n];
        if (!row) return;
        input.value = formatRef(row.ref, selfStore);
        results = [];
        close();
        input.focus();
    };

    const onInput = () => { cursor = 0; results = search(); paint(); };
    const onKey = (e) => {
        if (panel) {
            if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(cursor + 1, results.length - 1); paint(); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(cursor - 1, 0); paint(); return; }
            if (e.key === 'Enter') { e.preventDefault(); pick(cursor); return; }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); results = []; close(); return; }
        } else if (e.key === 'Enter' && input.value.trim() && onEnter) {
            e.preventDefault();
            onEnter();
        }
    };
    const onBlur = () => setTimeout(close, 120);

    input.setAttribute('autocomplete', 'off');
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);
    return {
        destroy() {
            close();
            input.removeEventListener('input', onInput);
            input.removeEventListener('keydown', onKey);
            input.removeEventListener('blur', onBlur);
        },
    };
}
