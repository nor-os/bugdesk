/**
 * command_palette.js — Ctrl+K center popup.
 *
 *   ┌─────────────────────────────────────────┐
 *   │ [agent ×] search…                       │  type chip + input
 *   ├─────────────────────────────────────────┤
 *   │ matched entity / command rows…          │  results
 *   ├─────────────────────────────────────────┤
 *   │ ↑↓ navigate   Enter open   Esc close    │  key hints
 *   └─────────────────────────────────────────┘
 *
 * Search-first and nothing else. Typing matches entities (fetched
 * lazily via the bridge) plus the STATIC_COMMANDS below; typing
 * `<prefix>:` promotes the prefix into a scope chip. With an empty
 * input and no chip the list shows the static commands, so the palette
 * never opens as a blank box.
 *
 * Deliberately NOT here: kind shortcut chips and left/right/bottom
 * panel toggles. Both already live in the global top bar, and
 * re-rendering navigation inside a search box only pushes the results
 * the user actually came for further down the popup.
 */

import { loadAllEntities, resolveTypePrefix } from './entity_sources.js';
import { getKindMeta } from './kind_taxonomy.js';
import { HelpModal } from '../help/help_modal.js';

const ROOT_ID = 'twm-cmdpal';

// Non-entity commands surfaced in the palette's search results. They
// carry an `action` so `commit()` runs them instead of opening a tile.
const STATIC_COMMANDS = [
    { kind: 'command', id: 'shortcuts', label: 'Keyboard shortcuts',
      hint: 'Show all key bindings (?)', icon: 'keyboard',
      action: () => HelpModal.open('keyboard-shortcuts') },
];

export function createCommandPalette({ wm, api }) {
    let overlay = null;
    let entities = [];

    const isOpen = () => !!overlay;
    const close = () => {
        if (!overlay) return;
        overlay.remove();
        overlay = null;
    };
    const toggle = () => { isOpen() ? close() : open(); };

    const open = async () => {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = ROOT_ID;
        overlay.className = 'twm-cmdpal-overlay';
        overlay.innerHTML = _markup();
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });

        const input = overlay.querySelector('.twm-cmdpal__input');
        const list = overlay.querySelector('[data-role="list"]');
        const chipSlot = overlay.querySelector('[data-role="type-chip"]');

        // Scoped-search state. Typing `<prefix>:` (e.g. `agent:`, `asset:`)
        // converts the prefix into a visual chip that lives to the left
        // of the input; subsequent typing only matches entities whose
        // navKind is in the chip's set. Cleared by clicking the chip's
        // ×, by pressing Backspace when the input is empty, or by Esc
        // (which closes the palette). Prefixes can resolve to MULTIPLE
        // navKinds — `agent:` covers archetypes + agent instances, for
        // example, so the user's mental model wins regardless of
        // whether the project has spun any instances up yet. The
        // resolver lives in `entity_sources.resolveTypePrefix` so the
        // alias table sits next to the data it scopes.
        let filtered = [];
        let active = 0;
        let typeFilter = null;        // null | string[] (navKinds)
        let typeFilterLabel = null;   // chip text, derived from the resolved kinds

        const renderChip = () => {
            if (!typeFilter) {
                chipSlot.innerHTML = '';
                return;
            }
            // Display: first kind's icon/label from the taxonomy.
            // Multi-kind aliases (e.g. agent: → archetype + agent) get
            // the leading kind's label — "Agent archetype" reads as
            // narrower than the alias actually is, so we override with
            // the alias label (passed from `refilter`) when it carries
            // information the taxonomy lookup can't infer.
            const head = typeFilter[0];
            const meta = getKindMeta(head);
            const label = typeFilterLabel || meta?.label || head;
            chipSlot.innerHTML = `
                <span class="twm-cmdpal__type-chip" title="Filtering by ${_esc(label)} (${typeFilter.length} kind${typeFilter.length === 1 ? '' : 's'})">
                    <span class="material-symbols-outlined twm-cmdpal__type-chip-icon">${meta?.icon || 'arrow_right'}</span>
                    <span class="twm-cmdpal__type-chip-label">${_esc(label)}</span>
                    <button type="button" class="twm-cmdpal__type-chip-x"
                            data-action="clear-type"
                            aria-label="Clear type filter">×</button>
                </span>
            `;
            chipSlot.querySelector('[data-action="clear-type"]')
                ?.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    typeFilter = null;
                    typeFilterLabel = null;
                    renderChip();
                    input.focus();
                    refilter();
                });
        };

        const render = () => {
            list.innerHTML = filtered.slice(0, 200).map((e, i) => `
                <div class="twm-cmdpal__item${i === active ? ' twm-cmdpal__item--active' : ''}"
                     data-idx="${i}">
                    <span class="material-symbols-outlined twm-cmdpal__icon">${e.icon || 'arrow_right'}</span>
                    <span class="twm-cmdpal__label">${_esc(e.label || e.id)}</span>
                    <span class="twm-cmdpal__kind">${e.kind}</span>
                    <span class="twm-cmdpal__hint">${_esc(e.hint || '')}</span>
                </div>
            `).join('') || '';
            list.querySelectorAll('[data-idx]').forEach((el) => {
                el.addEventListener('click', () => commit(Number(el.dataset.idx)));
            });
        };
        const commit = (i) => {
            const pick = filtered[i];
            if (!pick) return;
            close();
            if (pick.action) { try { pick.action(); } catch (err) { console.error(err); } return; }
            wm.openInPrimary(pick.kind, pick.props || { id: pick.id, label: pick.label });
        };

        /** Look for a `<prefix>:` at the start of the raw input. If the
         *  prefix resolves to one or more known kinds, promote it to
         *  the visual chip and strip it from the input field. Returns
         *  true when a chip was set so the caller can decide whether
         *  to re-render. */
        const tryConsumePrefix = () => {
            if (typeFilter) return false;
            const m = input.value.match(/^([a-zA-Z][a-zA-Z0-9_-]*):/);
            if (!m) return false;
            const kinds = resolveTypePrefix(m[1]);
            if (!kinds || kinds.length === 0) return false;
            typeFilter = kinds;
            typeFilterLabel = _titleCase(m[1]);
            input.value = input.value.slice(m[0].length);
            renderChip();
            return true;
        };

        const refilter = () => {
            tryConsumePrefix();
            const q = input.value.trim().toLowerCase();
            const filterSet = typeFilter ? new Set(typeFilter) : null;
            const pool = filterSet
                ? entities.filter((e) => filterSet.has(e.kind))
                : entities;
            if (!q) {
                // Scoped + empty query → list every entity of that
                // kind so the user sees what's available. Unscoped +
                // empty query → the static commands: they are the only
                // rows that are meaningful without a search term, and
                // an empty list would read as a broken palette now that
                // the shortcut chips are gone.
                filtered = typeFilter
                    ? pool.slice().sort((a, b) =>
                        String(a.label || a.id).localeCompare(b.label || b.id))
                    : pool.filter((e) => !!e.action);
            } else {
                filtered = _search(pool, q);
            }
            active = 0;
            render();
        };
        input.addEventListener('input', refilter);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                active = Math.min(filtered.length - 1, active + 1);
                render();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                active = Math.max(0, active - 1);
                render();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                commit(active);
            } else if (e.key === 'Escape') {
                close();
            } else if (e.key === 'Backspace' && input.value === '' && typeFilter) {
                // Empty input + active chip → consume Backspace to drop
                // the chip. Same idiom as Gmail / Linear / VS Code's
                // command palette: the chip behaves like a token before
                // the caret.
                e.preventDefault();
                typeFilter = null;
                typeFilterLabel = null;
                renderChip();
                refilter();
            }
        });
        input.focus();

        // Commands are searchable instantly; entity rows are lazy-loaded
        // — the palette stays usable for shortcuts/commands while we wait.
        // The set is rebuilt on every open so the palette reflects
        // entities the user just added this session (cheap; loadAllEntities
        // runs every source in parallel).
        entities = _decorateIcons(STATIC_COMMANDS.slice());
        refilter();   // paint the resting state (static commands) immediately
        if (api) {
            try {
                entities = _decorateIcons([...STATIC_COMMANDS, ...await loadAllEntities(api)]);
                // Re-filter so the freshly loaded rows show up. Skipped
                // once the user has moved the selection: clobbering
                // `active` mid-keyboard-navigation is worse than making
                // them touch a key to refresh the list.
                if (active === 0) refilter();
            } catch (err) {
                console.warn('[cmdpal] entity load failed', err);
            }
        }
    };

    return { open, close, toggle, isOpen };
}

function _markup() {
    return `
        <div class="twm-cmdpal" role="dialog" aria-label="Command palette">
            <div class="twm-cmdpal__inputrow">
                <span class="twm-cmdpal__type-chip-slot" data-role="type-chip"></span>
                <input type="text" class="twm-cmdpal__input"
                       placeholder="Search entities (try agent:foo, asset:bonds…)"
                       autocomplete="off" />
            </div>
            <div class="twm-cmdpal__list" data-role="list"></div>
            <div class="twm-cmdpal__footer">
                <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
                <span><kbd>Enter</kbd> open</span>
                <span><kbd>Esc</kbd> close</span>
            </div>
        </div>
    `;
}

/** Attach an icon per row by consulting the canonical kind taxonomy.
 *  Keeps the palette and breadcrumb visually consistent: one source
 *  of truth for what icon represents a given kind. */
function _decorateIcons(rows) {
    return rows.map((r) => {
        if (r.icon) return r;
        const meta = getKindMeta(r.kind);
        return { ...r, icon: meta?.icon || 'arrow_right' };
    });
}

function _search(entities, q) {
    const scored = [];
    for (const e of entities) {
        const id = String(e.id || '').toLowerCase();
        const label = String(e.label || '').toLowerCase();
        const hint = String(e.hint || '').toLowerCase();
        let r;
        if (id === q || label === q) r = 0;
        else if (id.startsWith(q))    r = 1;
        else if (label.startsWith(q)) r = 2;
        else if (id.includes(q))      r = 3;
        else if (label.includes(q))   r = 4;
        else if (hint.includes(q))    r = 5;
        else continue;
        scored.push({ e, r });
    }
    scored.sort((a, b) => a.r - b.r || a.e.label.localeCompare(b.e.label));
    return scored.map((x) => x.e);
}

function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

/** Display form for a typed prefix: convert `agent` → `Agent`, leave
 *  multi-word aliases (`market_arch`) as-is with the underscore
 *  swapped for a space and the first letter capitalised. Used for the
 *  scope chip label so it reflects what the user actually typed. */
function _titleCase(s) {
    const str = String(s || '').replace(/[_-]+/g, ' ').trim();
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
