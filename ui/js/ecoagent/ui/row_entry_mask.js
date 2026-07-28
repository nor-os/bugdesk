/**
 * row_entry_mask.js — the "Add row" entry mask, mounted into a host
 * element (a transient tab in the main content tile). Classic two-column
 * business form: right-aligned labels, a field column, and a bottom
 * action bar with a status dot (Cancel / Save & New / Save).
 *
 * Reference (foreign-key) columns — anything carrying `references`
 * `[target, col]`, the `agent_id` type, or a `<base>_id` name that
 * resolves to a known source — render as an ordinary `.ea-tin` text
 * input with a lightweight suggestion dropdown over the target entity's
 * labels: the user picks by name; the entity's id is what gets stored.
 *
 *   const mask = mountRowEntryMask(hostEl, {
 *       sourceId,                  // bottom-panel source id
 *       onClose:    () => {},      // Cancel / Save-and-done → close the tab
 *       onInserted: (sourceId) => {},  // a row was inserted
 *   });
 *   mask.dispose();
 */

import { widgetFor, coerceValue, ESCAPE_HTML } from './typed_inputs.js';
import { loadAllEntities } from '../../tiling/entity_sources.js';
import { openEntityRef } from './row_form.js';
import { toastInfo } from './toast.js';

const _api = () => window.pywebview?.api;

// `<base>_id` columns that conventionally point at an agent rather than a
// table named after the base (there is no `holders` table — a holder is
// an agent). Used by `_refTargetOf` when a column carries no explicit
// `references` metadata.
const AGENT_ROLES = new Set([
    'holder', 'issuer', 'owner', 'borrower', 'lender',
    'buyer', 'seller', 'counterparty', 'payer', 'payee', 'agent',
]);

export function mountRowEntryMask(hostEl, { sourceId, onClose, onInserted } = {}) {
    const mask = new RowEntryMask(hostEl, { sourceId, onClose, onInserted });
    mask.mount();
    return { dispose: () => mask.dispose() };
}

class RowEntryMask {
    constructor(hostEl, { sourceId, onClose, onInserted } = {}) {
        this.hostEl = hostEl;
        this.sourceId = String(sourceId || '');
        this.onClose = typeof onClose === 'function' ? onClose : () => {};
        this.onInserted = typeof onInserted === 'function' ? onInserted : () => {};
        this._cols = [];
        this._pk = 'auto';
        this._cands = {};   // target -> [{id, label}]   (reassigned as loads land)
        this._fkSel = {};   // colName -> selected id
        this._sources = new Set();  // queryable/known source ids (FK resolution)
        this._candsByKind = {};     // navKind -> [{id,label}]  (entity catalog)
        this._rowsCache = null;     // this source's existing rows (FK fallback)
        this._fkCleanup = [];       // teardown fns for the FK comboboxes
        this._refreshOpenMenu = null;  // re-filter the live menu when cands land
    }

    async mount() {
        try {
            const sid = this.sourceId;
            // Schema + source manifest together: `_refTargetOf` needs the
            // source list to resolve `<base>_id` columns before render.
            const [schema] = await Promise.all([
                this._fetchSchema(sid),
                this._loadSources(),
                this._loadEntityKinds(),
            ]);
            this._cols = Array.isArray(schema?.columns) ? schema.columns : [];
            this._pk = schema?.primary_key || 'auto';
            this._render();             // show the form immediately
            this._loadCandidates();     // fill FK candidate caches in the background
        } catch (err) {
            if (this.hostEl) {
                this.hostEl.innerHTML =
                    `<div class="ea-row-entry__empty">Couldn't open the entry form: ${ESCAPE_HTML(String(err?.message || err))}</div>`;
            }
            console.error('[row-entry] mount failed', err);
        }
    }

    dispose() {
        for (const fn of this._fkCleanup) { try { fn(); } catch { /* ignore */ } }
        this._fkCleanup = [];
        this._refreshOpenMenu = null;
        if (this.hostEl) this.hostEl.innerHTML = '';
    }

    // ── schema + source manifest ────────────────────────────────────

    async _fetchSchema(sid) {
        try {
            if (sid.startsWith('registry:')) {
                return await _api()?.world_registry_schema?.(sid.slice('registry:'.length));
            }
            if (sid.startsWith('table:')) {
                return await _api()?.table_get?.(sid.slice('table:'.length));
            }
        } catch { /* fall through to an empty mask */ }
        return null;
    }

    /** Cache the set of source ids so `_refTargetOf` can decide whether a
     *  `<base>_id` column has a real source to search. */
    async _loadSources() {
        try {
            const res = await _api()?.browser_sources_list?.();
            for (const s of (res?.sources || [])) {
                if (s?.id) this._sources.add(String(s.id));
            }
        } catch { /* leave _sources empty → FKs degrade to plain inputs */ }
    }

    /** Load the canonical entity catalog (`entity_sources.js`) grouped by
     *  navKind → [{id,label}]. This is how agents/sectors/markets/… are
     *  listed; `browser_query` only serves `registry:*`/`table:*` and
     *  cannot enumerate agents, which is why FK search needs this. */
    async _loadEntityKinds() {
        try {
            const all = await loadAllEntities(_api());
            for (const e of (all || [])) {
                if (!e || e.id == null) continue;
                (this._candsByKind[e.kind] ||= []).push({
                    id: String(e.id), label: String(e.label || e.id),
                });
            }
        } catch { /* no catalog → FKs over entity kinds degrade gracefully */ }
    }

    /** This source's existing rows (cached). Used as the FK fallback: a
     *  generated project has no materialized agent instances until the
     *  world is built, but the registry's own rows already reference real
     *  ids (e.g. `holder_id = banker-4`) — so distinct existing values
     *  make a useful candidate set with no build required. */
    async _currentRows() {
        if (this._rowsCache) return this._rowsCache;
        let rows = [];
        try {
            const sid = this.sourceId;
            if (sid.startsWith('registry:')) {
                const res = await _api()?.world_registry_rows?.(sid.slice('registry:'.length));
                rows = res?.entries || res?.rows || [];
            } else {
                const res = await _api()?.browser_query?.(sid, {});
                rows = (res && res.ok !== false && (res.rows || res.entries)) || [];
            }
        } catch { rows = []; }
        this._rowsCache = Array.isArray(rows) ? rows : [];
        return this._rowsCache;
    }

    /** Distinct existing values across every column that resolves to
     *  `target`, shaped as candidates. */
    async _fallbackFromRows(target) {
        const rows = await this._currentRows();
        if (!rows.length) return [];
        const cols = this._cols
            .filter((c) => this._refTargetOf(c) === target)
            .map((c) => c.name);
        const seen = new Set();
        const out = [];
        for (const r of rows) {
            for (const cn of cols) {
                const v = r?.[cn];
                if (v == null || v === '') continue;
                const id = String(v);
                if (seen.has(id)) continue;
                seen.add(id);
                out.push({ id, label: id });
            }
        }
        return out;
    }

    // ── reference (FK) candidates ───────────────────────────────────

    /** Follow a reference into the combined entity viewer (read-only),
     *  resolving the referenced row across queryable + relational sources
     *  (see `openEntityRef`). Degrades to a toast when the referenced row
     *  isn't materialized (e.g. agent instances in an un-built project). */
    async _followRef(target, id) {
        const ok = await openEntityRef(target, id, { api: _api() });
        if (!ok) toastInfo?.('Reference', `No detail view available for "${id}".`);
    }

    /** Candidate list for a target, matching both entity navKinds
     *  (singular, e.g. `agent`) and source ids (often plural, e.g.
     *  `agents`). */
    _kindCands(target) {
        const t = String(target || '');
        const singular = t.endsWith('s') ? t.slice(0, -1) : t;
        return this._candsByKind[t] || this._candsByKind[singular] || null;
    }

    /** Resolve a column's FK target, or null for a non-reference column.
     *  1) explicit `references`, 2) the `agent_id` type, 3) the
     *  `<base>_id` naming convention resolved against the entity catalog
     *  (agent-role bases → `agents`) or the source manifest. No match →
     *  plain typed input. */
    _refTargetOf(col) {
        if (Array.isArray(col.references) && col.references.length === 2) {
            return String(col.references[0]);
        }
        if ((col.type || '') === 'agent_id') return 'agents';
        const name = String(col.name || '');
        if (name.endsWith('_id') && name !== this._pk) {
            const base = name.slice(0, -3);
            if (AGENT_ROLES.has(base)) return 'agents';
            if (this._kindCands(base)) return base;
            if (this._kindCands(`${base}s`)) return `${base}s`;
            if (this._sources.has(base)) return base;
            if (this._sources.has(`${base}s`)) return `${base}s`;
        }
        return null;
    }

    /** Populate `this._cands[target]` for every FK column. Prefers the
     *  entity catalog (agents, sectors, …); falls back to `browser_query`
     *  for `registry:*`/`table:*` references. Reassigns `this._cands[t]`
     *  — comboboxes read it live, never snapshot. */
    async _loadCandidates() {
        const targets = new Set();
        for (const c of this._cols) {
            const t = this._refTargetOf(c);
            if (t) targets.add(t);
        }
        await Promise.all([...targets].map(async (t) => {
            if (Array.isArray(this._cands[t]) && this._cands[t].length) return;
            // 1) entity catalog (this is what makes agent search work).
            const fromKinds = this._kindCands(t);
            if (fromKinds && fromKinds.length) { this._cands[t] = fromKinds; return; }
            // 2) registry/table sources via browser_query.
            const tried = t.includes(':') ? [t] : [`registry:${t}`, `table:${t}`];
            for (const sid of tried) {
                try {
                    const res = await _api()?.browser_query?.(sid, {});
                    const rows = (res && res.ok !== false && (res.rows || res.entries)) || [];
                    if (!rows.length) continue;
                    this._cands[t] = rows.map((r) => {
                        const id = r.id ?? r[`${t}_id`] ?? r.name;
                        return id == null
                            ? null
                            : { id: String(id), label: String(r.label || r.name || id) };
                    }).filter(Boolean);
                    break;
                } catch { /* try the next prefix */ }
            }
            // 3) fallback — distinct values already present in this source.
            if (!Array.isArray(this._cands[t]) || !this._cands[t].length) {
                const fb = await this._fallbackFromRows(t);
                if (fb.length) this._cands[t] = fb;
            }
            if (!Array.isArray(this._cands[t])) this._cands[t] = [];
        }));
        // Candidates may have landed while a combobox is open — refresh it.
        try { this._refreshOpenMenu?.(); } catch { /* ignore */ }
    }

    _resolveRef(target, text) {
        const v = String(text || '').trim();
        if (!v) return '';
        const list = this._cands[target] || [];
        const byLabel = list.find((c) => c.label.toLowerCase() === v.toLowerCase());
        if (byLabel) return byLabel.id;
        if (list.some((c) => c.id === v)) return v;
        return v;
    }

    // ── render ──────────────────────────────────────────────────────

    _render() {
        if (!this.hostEl) return;
        const cols = this._cols;
        this.hostEl.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'ea-row-entry';

        const fields = cols.map((c) => this._fieldRow(c)).join('');
        wrap.innerHTML = `
            <div class="ea-row-entry__head">
                <span class="material-symbols-outlined">playlist_add</span>
                <span class="ea-row-entry__title">Add row</span>
                <span class="ea-row-entry__src">${ESCAPE_HTML(this.sourceId)}</span>
            </div>
            <form class="ea-row-entry__form">
                ${fields || '<div class="ea-row-entry__empty">This source has no editable columns.</div>'}
            </form>
            <div class="ea-row-entry__error" data-role="error" hidden></div>
            <div class="ea-row-entry__bar">
                <span class="ea-row-entry__status" data-role="status">
                    <span class="ea-row-entry__dot"></span><span data-role="status-text">ready</span>
                </span>
                <span class="ea-row-entry__actions">
                    <button type="button" class="ea-btn" data-action="cancel">Cancel</button>
                    <button type="button" class="ea-btn" data-action="save-new">Save &amp; New</button>
                    <button type="button" class="ea-btn ea-btn--primary" data-action="save">Save</button>
                </span>
            </div>
        `;
        this.hostEl.appendChild(wrap);
        this._mountFkFields(wrap);
        this._applyAutoIds();
        this._wire(wrap);
    }

    // ── automatic primary-key ids ───────────────────────────────────

    /** Next id for a string primary key, inferred from existing values:
     *  most-common `<prefix><number>` pattern → max+1 (e.g. bond-41 →
     *  bond-42); a fresh UUID when the ids are UUIDs; otherwise
     *  `<source-base>-<count>`. */
    _nextId(values) {
        const vals = (values || []).map((v) => String(v)).filter(Boolean);
        const byPrefix = {};
        for (const v of vals) {
            const m = v.match(/^(.*?)(\d+)$/);
            if (!m) continue;
            (byPrefix[m[1]] ||= []).push(parseInt(m[2], 10));
        }
        const prefixes = Object.keys(byPrefix);
        if (prefixes.length) {
            prefixes.sort((a, b) => byPrefix[b].length - byPrefix[a].length);
            const p = prefixes[0];
            return `${p}${Math.max(...byPrefix[p]) + 1}`;
        }
        // No numeric pattern. If the ids are UUIDs, mint a fresh one.
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (vals.length && vals.every((v) => UUID_RE.test(v))) {
            try { return crypto.randomUUID(); } catch { /* fall through */ }
        }
        const base = (this.sourceId.split(':')[1] || 'row')
            .replace(/_holdings$/, '').replace(/s$/, '');
        return `${base}-${vals.length}`;
    }

    /** Pre-fill a string primary key with a generated id so the user
     *  doesn't have to invent one (still editable). Async — waits for the
     *  source's existing rows so the counter continues from the max. */
    async _applyAutoIds() {
        const pk = this._pk;
        if (!pk || pk === 'auto') return;
        const col = this._cols.find((c) => c.name === pk);
        if (!col) return;
        const t = col.type || 'str';
        if (t !== 'str' && t !== 'agent_id') return;  // only string-ish ids
        const wrap = this.hostEl?.querySelector('.ea-row-entry');
        const input = wrap?.querySelector(`[name="${CSS.escape(pk)}"]`);
        if (!input || input.value) return;             // never clobber typed text
        const rows = await this._currentRows();
        const vals = rows.map((r) => r?.[pk]).filter((v) => v != null && v !== '');
        const next = this._nextId(vals);
        if (!next || input.value) return;
        input.value = next;
        input.dataset.autoid = '1';
        const label = input.closest('.ea-row-entry__row')?.querySelector('.ea-row-entry__label');
        if (label && !label.querySelector('.ea-row-entry__auto')) {
            const b = document.createElement('span');
            b.className = 'ea-row-entry__auto';
            b.textContent = 'auto';
            b.title = 'auto-generated id (editable)';
            label.appendChild(b);
        }
    }

    _fieldRow(col) {
        const name = col.name;
        if (!name) return '';
        const isPk = name === this._pk;
        const target = this._refTargetOf(col);
        const isRef = !!target;
        const reqMark = col.nullable === false ? '<span class="ea-row-entry__req" title="required">*</span>' : '';
        const typeTag = `<span class="ea-row-entry__type">${ESCAPE_HTML(col.type || 'str')}</span>`;
        // Reference columns render as an ordinary `.ea-tin` text input
        // (identical look to every other field) with an attached
        // suggestion dropdown; the resolved id shows inline as a hint.
        const field = isRef
            ? `<input type="text" class="ea-tin ea-tin--text ea-row-entry__fk"`
              + ` data-fk="${ESCAPE_HTML(name)}" autocomplete="off" spellcheck="false"`
              + ` placeholder="search ${ESCAPE_HTML(target)}…">`
              + `<span class="ea-row-entry__resolved" data-resolved="${ESCAPE_HTML(name)}"></span>`
            : widgetFor(col, col.default ?? null, false);
        return `
            <label class="ea-row-entry__row" data-field="${ESCAPE_HTML(name)}">
                <span class="ea-row-entry__label">${ESCAPE_HTML(name)}${reqMark} ${typeTag}${isPk ? '<span class="ea-row-entry__pk">pk</span>' : ''}</span>
                <span class="ea-row-entry__cell">${field}</span>
            </label>`;
    }

    _mountFkFields(wrap) {
        this._fkCleanup = [];
        this._refreshOpenMenu = null;
        for (const col of this._cols) {
            const target = this._refTargetOf(col);
            if (!target) continue;
            const input = wrap.querySelector(`[data-fk="${CSS.escape(col.name)}"]`);
            if (!input) continue;
            const cell = input.closest('.ea-row-entry__cell') || input.parentElement;
            const resolvedEl = wrap.querySelector(`[data-resolved="${CSS.escape(col.name)}"]`);
            this._fkCleanup.push(this._wireFkCombo(col, target, input, cell, resolvedEl));
        }
    }

    /** Wire one reference input as a lightweight combobox over the live
     *  candidate cache. Reads `this._cands[target]` at filter time (never
     *  snapshots — that was the old search bug) and stores the picked
     *  entity id in `this._fkSel`. Returns a teardown fn. */
    _wireFkCombo(col, target, input, cell, resolvedEl) {
        const name = col.name;
        const menu = document.createElement('div');
        menu.className = 'ea-row-entry__menu';
        menu.hidden = true;
        cell.appendChild(menu);

        // Reference chip shown once an entity is picked (replaces the
        // editable input so the choice reads as a stable reference, like
        // the table's entity links — not a shrinking text field).
        const chip = document.createElement('span');
        chip.className = 'ea-row-entry__refchip';
        chip.hidden = true;
        cell.appendChild(chip);

        let items = [];
        let active = -1;
        let open = false;

        const setHint = (id) => { if (resolvedEl) resolvedEl.textContent = id ? `→ ${id}` : ''; };
        const filtered = (q) => {
            const s = String(q || '').trim().toLowerCase();
            const list = this._cands[target] || [];   // LIVE read
            const out = s
                ? list.filter((c) => c.label.toLowerCase().includes(s)
                                  || c.id.toLowerCase().includes(s))
                : list;
            return out.slice(0, 50);
        };
        const renderMenu = () => {
            menu.innerHTML = items.map((c, i) =>
                `<div class="ea-row-entry__opt${i === active ? ' active' : ''}" role="option" data-i="${i}">`
                + `<span class="ea-row-entry__opt-label">${ESCAPE_HTML(c.label)}</span>`
                + `<span class="ea-row-entry__opt-id">${ESCAPE_HTML(c.id)}</span></div>`).join('');
        };
        const closeMenu = () => { menu.hidden = true; open = false; active = -1; };
        const openMenu = () => {
            items = filtered(input.value);
            active = items.length ? 0 : -1;
            renderMenu();
            if (items.length) { menu.hidden = false; open = true; }
            else closeMenu();
        };
        const pick = (i) => {
            const c = items[i];
            if (!c) return;
            this._fkSel[name] = c.id;
            setHint(c.id);
            closeMenu();
            showChip(c.id, c.label);
        };
        const resolveFree = () => {
            this._fkSel[name] = this._resolveRef(target, input.value);
            setHint(this._fkSel[name]);
        };

        // ── reference chip ──────────────────────────────────────────
        // Clicking a chip follows the reference into the combined entity
        // viewer (a non-modal window, read-only); the `×` clears it.
        const openRef = () => {
            const id = this._fkSel[name];
            if (id) this._followRef(target, id);
        };
        const showChip = (id, label) => {
            chip.dataset.label = label;
            chip.title = 'Open reference';
            chip.classList.add('ea-row-entry__refchip--nav');
            chip.innerHTML =
                '<span class="material-symbols-outlined ea-row-entry__refchip-icon">link</span>'
                + `<span class="ea-row-entry__refchip-label">${ESCAPE_HTML(label)}</span>`
                + `<span class="ea-row-entry__refchip-id">${ESCAPE_HTML(id)}</span>`
                + '<button type="button" class="ea-row-entry__refchip-clear" title="Change">×</button>';
            input.hidden = true;
            if (resolvedEl) resolvedEl.hidden = true;
            chip.hidden = false;
        };
        const clearChip = () => {
            this._fkSel[name] = '';
            setHint('');
            chip.hidden = true;
            input.hidden = false;
            if (resolvedEl) resolvedEl.hidden = false;
            input.value = '';
            input.focus();
        };
        const onChipClick = (ev) => {
            if (ev.target.closest('.ea-row-entry__refchip-clear')) { clearChip(); return; }
            openRef();
        };
        chip.addEventListener('click', onChipClick);

        const onInput = () => { resolveFree(); openMenu(); };
        const onFocus = () => openMenu();
        const onKeyDown = (ev) => {
            if (!open) {
                if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); openMenu(); }
                return;
            }
            if (ev.key === 'ArrowDown') { ev.preventDefault(); active = (active + 1) % items.length; renderMenu(); }
            else if (ev.key === 'ArrowUp') { ev.preventDefault(); active = (active - 1 + items.length) % items.length; renderMenu(); }
            else if (ev.key === 'Enter') { if (active >= 0) { ev.preventDefault(); pick(active); } }
            else if (ev.key === 'Escape') { ev.preventDefault(); closeMenu(); }
            else if (ev.key === 'Tab') { if (active >= 0) pick(active); }
        };
        const onBlur = () => setTimeout(() => {
            if (document.activeElement !== input && !menu.contains(document.activeElement)) {
                resolveFree();
                closeMenu();
            }
        }, 120);
        const onMenuMouseDown = (ev) => ev.preventDefault();   // keep input focus
        const onMenuClick = (ev) => {
            const opt = ev.target.closest('.ea-row-entry__opt');
            if (opt) pick(parseInt(opt.dataset.i, 10));
        };

        input.addEventListener('input', onInput);
        input.addEventListener('focus', onFocus);
        input.addEventListener('keydown', onKeyDown);
        input.addEventListener('blur', onBlur);
        menu.addEventListener('mousedown', onMenuMouseDown);
        menu.addEventListener('click', onMenuClick);

        // Chain into the refresh hook so `_loadCandidates` re-filters this
        // menu if it's open when candidates finally land.
        const prevRefresh = this._refreshOpenMenu;
        this._refreshOpenMenu = () => { try { prevRefresh?.(); } catch { /* ignore */ } if (open) openMenu(); };

        return () => {
            input.removeEventListener('input', onInput);
            input.removeEventListener('focus', onFocus);
            input.removeEventListener('keydown', onKeyDown);
            input.removeEventListener('blur', onBlur);
            menu.removeEventListener('mousedown', onMenuMouseDown);
            menu.removeEventListener('click', onMenuClick);
            chip.removeEventListener('click', onChipClick);
            try { menu.remove(); } catch { /* ignore */ }
            try { chip.remove(); } catch { /* ignore */ }
        };
    }

    _wire(wrap) {
        wrap.querySelector('[data-action="cancel"]')?.addEventListener('click', () => this.onClose());
        wrap.querySelector('[data-action="save"]')?.addEventListener('click', () => this._save({ keepOpen: false }));
        wrap.querySelector('[data-action="save-new"]')?.addEventListener('click', () => this._save({ keepOpen: true }));
        wrap.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') { ev.preventDefault(); this.onClose(); }
            else if (ev.key === 'Enter' && ev.target.tagName !== 'TEXTAREA'
                     && !ev.target.classList.contains('ea-row-entry__fk')) {
                ev.preventDefault(); this._save({ keepOpen: false });
            }
        });
        requestAnimationFrame(() => {
            wrap.querySelector('.ea-row-entry__form input, .ea-row-entry__form textarea')?.focus();
        });
    }

    // ── collect + save ──────────────────────────────────────────────

    _collect(wrap) {
        const row = {};
        for (const col of this._cols) {
            const name = col.name;
            if (!name) continue;
            const target = this._refTargetOf(col);
            if (target) {
                const fkInput = wrap.querySelector(`[data-fk="${CSS.escape(name)}"]`);
                const id = this._fkSel[name] || this._resolveRef(target, fkInput?.value);
                if (!id) {
                    if (col.nullable === false) throw new Error(`"${name}" is required`);
                    row[name] = null;
                } else { row[name] = id; }
                continue;
            }
            const el = wrap.querySelector(`[name="${CSS.escape(name)}"]`);
            if (!el) continue;
            const raw = el.type === 'checkbox' ? el.checked : el.value;
            if (raw === '' || raw == null) {
                if (col.nullable === false && col.type !== 'bool') {
                    throw new Error(`"${name}" is required`);
                }
                row[name] = null;
                continue;
            }
            row[name] = coerceValue(raw, col.type);
        }
        return row;
    }

    _crudInsert(row) {
        const sid = this.sourceId;
        const api = _api();
        if (sid.startsWith('registry:')) return api?.world_registry_insert?.(sid.slice('registry:'.length), row);
        if (sid.startsWith('table:'))    return api?.table_insert?.(sid.slice('table:'.length), row);
        return Promise.resolve({ ok: false, error: 'source is not writable' });
    }

    async _save({ keepOpen }) {
        const wrap = this.hostEl?.querySelector('.ea-row-entry');
        if (!wrap) return;
        this._status('saving…', 'busy');
        let row;
        try { row = this._collect(wrap); }
        catch (exc) { this._error(String(exc?.message || exc)); this._status('error', 'err'); return; }
        try {
            const res = await this._crudInsert(row);
            if (!res || res.ok === false) { this._error(res?.error || 'insert failed'); this._status('error', 'err'); return; }
        } catch (exc) { this._error(String(exc?.message || exc)); this._status('error', 'err'); return; }
        this._error('');
        this._fkSel = {};
        this._rowsCache = null;   // new row exists → re-derive next auto-id
        try { this.onInserted(this.sourceId); } catch { /* ignore */ }
        if (keepOpen) { this._render(); this._status('saved — add another', 'ok'); }
        else { this.onClose(); }
    }

    _status(text, kind) {
        const root = this.hostEl?.querySelector('[data-role="status"]');
        const txt = this.hostEl?.querySelector('[data-role="status-text"]');
        if (txt) txt.textContent = text;
        if (root) root.dataset.kind = kind || '';
    }

    _error(msg) {
        const el = this.hostEl?.querySelector('[data-role="error"]');
        if (el) { el.textContent = msg || ''; el.hidden = !msg; }
    }
}
