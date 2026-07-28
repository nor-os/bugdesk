/**
 * tag_input.js — the Labels field, as removable pills with autocomplete.
 *
 * Replaces a comma-separated text input. Comma-separated text was fine to
 * store and terrible to edit: no way to see which labels exist already, so
 * the store accumulated `ai-behavior` next to `ai_behaviour` next to
 * `aibehavior`. The suggestion list is drawn from labels already in use, so
 * the path of least resistance is now reusing an existing one.
 *
 * The hidden input keeps the original `data-f="labels"` contract — the mask
 * still reads it with `fval('labels')` and still gets `a, b, c` — so nothing
 * downstream had to learn about pills.
 */

import { esc } from './data.js';

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

/** Normalise a typed label: trimmed, lowercased, spaces → dashes. Keeps the
 *  vocabulary in one shape so `Path Finding` and `path-finding` cannot both
 *  exist. */
const normalize = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/,/g, '');

/**
 * Turn `input` into a pill editor.
 *
 * @param {HTMLInputElement} input   the existing `data-f="labels"` field; it
 *        is hidden and kept in sync as the value carrier.
 * @param {object} opts
 * @param {string[]} [opts.suggestions=[]]  vocabulary for autocomplete.
 * @param {Function} [opts.onChange]        called with the tag array.
 * @returns {{destroy: Function, getTags: Function, setTags: Function}}
 */
export function attachTagInput(input, { suggestions = [], onChange = null } = {}) {
    let tags = String(input.value || '').split(',').map(normalize).filter(Boolean);
    tags = Array.from(new Set(tags));

    const root = document.createElement('div');
    root.className = 'td-tags';
    input.parentNode.insertBefore(root, input);
    input.type = 'hidden';
    root.appendChild(input);

    const field = document.createElement('div');
    field.className = 'td-tags__field';
    const entry = document.createElement('input');
    entry.type = 'text';
    entry.className = 'td-tags__entry';
    entry.placeholder = 'add label…';
    entry.autocomplete = 'off';
    entry.setAttribute('aria-label', 'Add label');

    const menu = document.createElement('div');
    menu.className = 'td-tags__menu';
    menu.hidden = true;

    root.appendChild(field);
    root.appendChild(menu);

    let active = -1;      // highlighted suggestion index
    let matches = [];

    const sync = () => {
        input.value = tags.join(', ');
        // The mask's dirty tracking listens for `input` on [data-f] elements.
        input.dispatchEvent(new Event('input', { bubbles: true }));
        onChange?.(tags.slice());
    };

    const renderTags = () => {
        field.innerHTML = tags.map((t, i) => `
            <span class="td-tag">
                <span class="td-tag__label">${esc(t)}</span>
                <button type="button" class="td-tag__x" data-i="${i}"
                        aria-label="Remove label ${esc(t)}" tabindex="-1">${icon('close')}</button>
            </span>`).join('');
        field.appendChild(entry);
    };

    const closeMenu = () => { menu.hidden = true; active = -1; matches = []; };

    const renderMenu = () => {
        const q = normalize(entry.value);
        const pool = suggestions
            .map(normalize).filter(Boolean)
            .filter((s, i, a) => a.indexOf(s) === i && !tags.includes(s));
        matches = q
            ? pool.filter((s) => s.includes(q))
                .sort((a, b) => a.indexOf(q) - b.indexOf(q) || a.localeCompare(b))
            : pool.slice().sort();
        if (!matches.length) { closeMenu(); return; }
        if (active >= matches.length) active = matches.length - 1;
        menu.innerHTML = matches.slice(0, 40).map((s, i) => {
            // Highlight the matched run so it is obvious WHY a row is offered.
            const at = q ? s.indexOf(q) : -1;
            const label = at < 0 ? esc(s)
                : `${esc(s.slice(0, at))}<b>${esc(s.slice(at, at + q.length))}</b>${esc(s.slice(at + q.length))}`;
            return `<div class="td-tags__opt${i === active ? ' td-tags__opt--on' : ''}" data-i="${i}">${label}</div>`;
        }).join('');
        menu.hidden = false;
    };

    const add = (raw) => {
        const t = normalize(raw);
        if (!t || tags.includes(t)) { entry.value = ''; closeMenu(); return; }
        tags.push(t);
        entry.value = '';
        renderTags();
        closeMenu();
        sync();
        entry.focus();
    };

    const removeAt = (i) => {
        if (i < 0 || i >= tags.length) return;
        tags.splice(i, 1);
        renderTags();
        sync();
        entry.focus();
    };

    const onFieldClick = (e) => {
        const x = e.target.closest('.td-tag__x');
        if (x) { e.preventDefault(); removeAt(Number(x.dataset.i)); return; }
        if (e.target === field) entry.focus();
    };

    const onEntryKey = (e) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add(active >= 0 && matches[active] ? matches[active] : entry.value);
            return;
        }
        if (e.key === 'Backspace' && !entry.value) {
            // Empty field + Backspace eats the previous pill — the same idiom
            // the command palette's type chip uses.
            e.preventDefault();
            removeAt(tags.length - 1);
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (menu.hidden) { renderMenu(); if (menu.hidden) return; }
            e.preventDefault();
            active = e.key === 'ArrowDown'
                ? Math.min(matches.length - 1, active + 1)
                : Math.max(0, active - 1);
            renderMenu();
            return;
        }
        if (e.key === 'Escape' && !menu.hidden) { e.preventDefault(); closeMenu(); }
    };

    const onMenuClick = (e) => {
        const opt = e.target.closest('[data-i]');
        if (opt) add(matches[Number(opt.dataset.i)]);
    };
    // mousedown would blur the entry before click lands; suppress the blur.
    const onMenuDown = (e) => e.preventDefault();

    const onEntryInput = () => { active = -1; renderMenu(); };
    const onEntryFocus = () => renderMenu();
    const onEntryBlur = () => {
        // Commit whatever was typed rather than silently dropping it.
        if (entry.value.trim()) add(entry.value);
        closeMenu();
    };

    field.addEventListener('click', onFieldClick);
    entry.addEventListener('keydown', onEntryKey);
    entry.addEventListener('input', onEntryInput);
    entry.addEventListener('focus', onEntryFocus);
    entry.addEventListener('blur', onEntryBlur);
    menu.addEventListener('click', onMenuClick);
    menu.addEventListener('mousedown', onMenuDown);

    renderTags();

    return {
        getTags: () => tags.slice(),
        setTags: (next) => {
            tags = Array.from(new Set((next || []).map(normalize).filter(Boolean)));
            renderTags();
            sync();
        },
        destroy() {
            field.removeEventListener('click', onFieldClick);
            entry.removeEventListener('keydown', onEntryKey);
            entry.removeEventListener('input', onEntryInput);
            entry.removeEventListener('focus', onEntryFocus);
            entry.removeEventListener('blur', onEntryBlur);
            menu.removeEventListener('click', onMenuClick);
            menu.removeEventListener('mousedown', onMenuDown);
        },
    };
}
