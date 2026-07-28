/**
 * project_setup_tab.js — the workspace tab opened from project.json.
 *
 * The single home for *project-global, cross-cutting setup*:
 *
 *   • Currencies      — CRUD over the declared currency list
 *   • Countries       — CRUD with on-the-fly bank-archetype creation
 *   • FX overview     — live rates per pair + peg corridor status
 *   • Real-asset MtM  — registered quoting markets + fallback values
 *
 * Sectors stay on the SFC sidebar (Countries & Sectors hierarchy);
 * markets on the Markets sidebar; agents on the Agents sidebar. This
 * tab is the *index* + edit surface for everything that doesn't fit
 * into those per-entity sidebars — and the place where the user
 * answers "how is this project configured globally?"
 *
 * Read-mostly with jump-out links: deep edits (e.g. archetype params,
 * sector accounts) still happen on the canonical surface. The tab
 * itself owns Currency / Country CRUD because those entities have no
 * other home.
 */

import { openConfirm, openForm } from '../ui/modal.js';
import { esc } from './_util.js';

const fmt4 = (v) => (v == null || !Number.isFinite(v)) ? '—' : Number(v).toFixed(4);
const fmt2 = (v) => (v == null || !Number.isFinite(v)) ? '—' : Number(v).toFixed(2);

/** Slugify a label → kebab-case id. Used by the country dialog so
 *  the user doesn't have to think of an id separately from the
 *  display name. */
function slugify(s) {
    return String(s || '')
        .trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

export function makeProjectSetupTab(hostEl, _entityId, ctx) {
    return new ProjectSetupTab(hostEl, ctx);
}

class ProjectSetupTab {
    constructor(hostEl, { logger, workspaceTabs, eventBus } = {}) {
        this.hostEl = hostEl;
        this.logger = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.workspaceTabs = workspaceTabs ?? null;
        this.eventBus = eventBus ?? null;
        this._currencies = [];
        this._countries = [];
        this._archetypes = [];
        this._sectors = [];
        this._fxPairs = [];
        this._fxActive = false;
        this._mtm = { kinds: [], active: false };
        this._tickHandler = () => this._refreshLive();
    }

    async mount() {
        // Outer markup mirrors the agent tab exactly: flex column with
        // `.ea-agent-editor`'s padding-free shell, the standard
        // `.ea-detail-header` chrome strip, and a `__body` scroll
        // pane with --ea-pad-snug padding. Cards drop into the body
        // the same way the agent's Identity / Parameters cards do.
        this.hostEl.innerHTML = `
            <div class="ea-project-setup">
                <header class="ea-detail-header">
                    <h2>Project setup</h2>
                    <span class="ea-detail-header__spacer"></span>
                    <small class="ea-text--muted">project.json</small>
                </header>
                <div class="ea-project-setup__body">
                <section class="ea-card" data-card="currencies">
                    <div class="ea-card__head-row">
                        <h3 class="ea-card__title">Currencies</h3>
                        <button class="ea-btn" data-action="add-currency">+ Currency</button>
                    </div>
                    <div data-host="currencies"></div>
                </section>
                <section class="ea-card" data-card="countries">
                    <div class="ea-card__head-row">
                        <h3 class="ea-card__title"
                            title="Each country owns one currency and optionally names a bank agent as its central bank. Bind sectors via the SFC sidebar.">
                            Countries</h3>
                        <button class="ea-btn" data-action="add-country">+ Country</button>
                    </div>
                    <div data-host="countries"></div>
                </section>
                <section class="ea-card" data-card="fx">
                    <div class="ea-card__head-row">
                        <h3 class="ea-card__title"
                            title="Live mid prices per declared FX pair. Pegged pairs show their CB's corridor; status flips when the mid breaches floor or ceiling.">
                            FX overview</h3>
                        <span class="ea-fx-summary" data-host="fx-summary"></span>
                    </div>
                    <div data-host="fx"></div>
                </section>
                <section class="ea-card" data-card="mtm">
                    <h3 class="ea-card__title"
                        title="Each non-financial asset kind registered against its quoting market + fallback book value. Read-only; pulled at world construction.">
                        Real-asset mark-to-market</h3>
                    <div data-host="mtm"></div>
                </section>
                </div>
            </div>
        `;
        this.hostEl.querySelector('[data-action="add-currency"]')
            ?.addEventListener('click', () => this._onAddCurrency());
        this.hostEl.querySelector('[data-action="add-country"]')
            ?.addEventListener('click', () => this._onAddCountry());
        // Live FX refresh on every tick push from the run controller.
        this.eventBus?.on?.('ecoagent:run:tick', this._tickHandler);
        await this._refresh();
    }

    show()  {}
    hide()  {}
    dispose() {
        this.eventBus?.off?.('ecoagent:run:tick', this._tickHandler);
    }

    /** Used by the workspace-tab refresh hook. Live state refresh
     *  only — the bridge calls for static config aren't tick-driven. */
    async refresh(reason) {
        if (reason === 'tick') {
            await this._refreshLive();
            return;
        }
        await this._refresh();
    }

    // ------------------------------------------------------- data loaders

    async _refresh() {
        try {
            const [ccys, countries, archetypes, sectors] = await Promise.all([
                window.pywebview?.api?.currencies_list?.() ?? [],
                window.pywebview?.api?.countries_list?.()  ?? [],
                window.pywebview?.api?.agents_list?.() ?? [],
                window.pywebview?.api?.sectors_list?.()    ?? [],
            ]);
            this._currencies = Array.isArray(ccys) ? ccys : [];
            this._countries  = Array.isArray(countries) ? countries : [];
            this._archetypes = Array.isArray(archetypes) ? archetypes : [];
            this._sectors    = Array.isArray(sectors) ? sectors : [];
        } catch (e) {
            this.logger.warn?.('project setup fetch failed', e);
        }
        this._renderCurrencies();
        this._renderCountries();
        await this._refreshLive();
    }

    async _refreshLive() {
        try {
            const r = await window.pywebview?.api?.fx_overview?.();
            this._fxActive = !!r?.active;
            this._fxPairs  = Array.isArray(r?.pairs) ? r.pairs : [];
        } catch { this._fxActive = false; this._fxPairs = []; }
        this._renderFx();
        this._renderMtm();
    }

    // ------------------------------------------------------ card: currencies

    _renderCurrencies() {
        const host = this.hostEl.querySelector('[data-host="currencies"]');
        if (!host) return;
        if (this._currencies.length === 0) {
            host.innerHTML = `<p class="ea-card__empty">No currencies declared. Add at least one to enable payments.</p>`;
            return;
        }
        // For each currency: list which countries claim it (useful at
        // a glance — currency unions show as multiple countries on one row).
        const rows = this._currencies.map((c) => {
            const claimed = this._countries.filter((co) => co.currency === c.id);
            const where = claimed.length === 0
                ? '<span class="ea-text--muted">unassigned</span>'
                : claimed.map((co) => esc(co.label || co.id)).join(', ');
            return `
                <tr>
                    <td><b>${esc(c.id)}</b>${c.symbol ? ` <span class="ea-text--muted">${esc(c.symbol)}</span>` : ''}</td>
                    <td>${esc(c.label || '')}</td>
                    <td>${where}</td>
                    <td class="ea-fx-num">
                        <button class="ea-btn ea-btn--small" data-action="edit-currency" data-id="${esc(c.id)}">Edit</button>
                        <button class="ea-btn ea-btn--small" data-action="remove-currency" data-id="${esc(c.id)}">Remove</button>
                    </td>
                </tr>`;
        }).join('');
        host.innerHTML = `
            <table class="ea-table">
                <thead><tr>
                    <th>Id</th><th>Label</th>
                    <th>Used by</th><th class="ea-fx-num"></th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        `;
        host.querySelectorAll('[data-action="edit-currency"]').forEach((b) =>
            b.addEventListener('click', () => this._onEditCurrency(b.dataset.id)));
        host.querySelectorAll('[data-action="remove-currency"]').forEach((b) =>
            b.addEventListener('click', () => this._onRemoveCurrency(b.dataset.id)));
    }

    async _onAddCurrency() {
        const data = await openForm({
            title: 'Add currency',
            fields: [
                { name: 'code',  label: 'Code (ISO 4217)',     type: 'text', required: true, placeholder: 'EUR' },
                { name: 'label', label: 'Label',               type: 'text', placeholder: 'Euro' },
                { name: 'symbol',label: 'Symbol (optional)',   type: 'text', placeholder: '€' },
            ],
            submitLabel: 'Add',
        });
        if (!data) return;
        const id = String(data.code || '').trim().toUpperCase();
        if (!id) return;
        await window.pywebview?.api?.currency_add?.(
            id, String(data.label || id), String(data.symbol || ''),
        );
        await this._refresh();
    }

    async _onEditCurrency(id) {
        const c = this._currencies.find((x) => x.id === id);
        if (!c) return;
        const data = await openForm({
            title: `Edit currency "${id}"`,
            fields: [
                { name: 'label',  label: 'Label',  type: 'text', default: c.label || '' },
                { name: 'symbol', label: 'Symbol', type: 'text', default: c.symbol || '' },
            ],
            submitLabel: 'Save',
        });
        if (!data) return;
        await window.pywebview?.api?.currency_update?.(
            id, null,
            String(data.label ?? c.label ?? ''),
            String(data.symbol ?? c.symbol ?? ''),
        );
        await this._refresh();
    }

    async _onRemoveCurrency(id) {
        const ok = await openConfirm({
            title: `Remove currency "${id}"`,
            message: `Remove the currency definition. Countries pointing at ${id} will need to be re-pointed.`,
            confirmLabel: 'Remove', danger: true,
        });
        if (!ok) return;
        await window.pywebview?.api?.currency_remove?.(id);
        await this._refresh();
    }

    // ------------------------------------------------------ card: countries

    _renderCountries() {
        const host = this.hostEl.querySelector('[data-host="countries"]');
        if (!host) return;
        if (this._countries.length === 0) {
            host.innerHTML = `<p class="ea-card__empty">No countries declared. Add one to start binding sectors to a jurisdiction.</p>`;
            return;
        }
        const rows = this._countries.map((co) => {
            const ccy = this._currencies.find((c) => c.id === co.currency);
            const ccyCell = ccy
                ? `<b>${esc(ccy.id)}</b>${ccy.symbol ? ` <span class="ea-text--muted">${esc(ccy.symbol)}</span>` : ''}`
                : `<span class="ea-check ea-check--leak">${esc(co.currency || 'unset')}</span>`;
            const cb = co.central_bank
                ? esc(co.central_bank)
                : '<span class="ea-text--muted">—</span>';
            // Count sectors bound to this country for a quick footprint.
            const nSectors = this._sectors.filter((s) => s.country === co.id).length;
            return `
                <tr>
                    <td><b>${esc(co.label || co.id)}</b><br><small class="ea-text--muted">${esc(co.id)}</small></td>
                    <td>${ccyCell}</td>
                    <td>${cb}</td>
                    <td class="ea-fx-num">${nSectors}</td>
                    <td class="ea-fx-num">
                        <button class="ea-btn ea-btn--small" data-action="edit-country" data-id="${esc(co.id)}">Edit</button>
                        <button class="ea-btn ea-btn--small" data-action="remove-country" data-id="${esc(co.id)}">Remove</button>
                    </td>
                </tr>`;
        }).join('');
        host.innerHTML = `
            <table class="ea-table">
                <thead><tr>
                    <th>Country</th><th>Currency</th>
                    <th>Central bank</th>
                    <th class="ea-fx-num">Sectors</th>
                    <th class="ea-fx-num"></th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        `;
        host.querySelectorAll('[data-action="edit-country"]').forEach((b) =>
            b.addEventListener('click', () => this._onEditCountry(b.dataset.id)));
        host.querySelectorAll('[data-action="remove-country"]').forEach((b) =>
            b.addEventListener('click', () => this._onRemoveCountry(b.dataset.id)));
    }

    /** Bank-role archetypes available as CB candidates. Filtered to
     *  `role === 'bank'` so workers/firms don't pollute the dropdown. */
    _bankArchetypes() {
        return this._archetypes.filter((a) => (a.role || '') === 'bank');
    }

    /** Sectors marked as financial (or labelled banks/CB-ish) — used
     *  as the default `default_sector` suggestion when the user spins
     *  up a new bank archetype from inside the country dialog. */
    _defaultBankSector() {
        const fin = this._sectors.find((s) => s.kind === 'financial');
        return fin?.id || this._sectors[0]?.id || '';
    }

    /** Build the Central bank dropdown options for the country form.
     *  Final option is the on-the-fly creation sentinel — selecting it
     *  pops a sub-dialog to spin up a fresh bank archetype. */
    _cbOptions() {
        const banks = this._bankArchetypes();
        return [
            { value: '', label: '(no central bank)' },
            ...banks.map((b) => ({ value: b.archetype, label: b.label || b.archetype })),
            { value: '__new__', label: '+ Create new bank agent…' },
        ];
    }

    async _onAddCountry() {
        const data = await openForm({
            title: 'Add country',
            fields: [
                { name: 'label', label: 'Country name', type: 'text', required: true,
                  placeholder: 'Germany' },
                { name: 'currency', label: 'Currency', type: 'select',
                  options: [
                      { value: '', label: '(pick one)' },
                      ...this._currencies.map((c) => ({
                          value: c.id, label: `${c.id} — ${c.label || c.id}`,
                      })),
                  ],
                  required: true },
                { name: 'central_bank', label: 'Central bank agent', type: 'select',
                  options: this._cbOptions(), default: '' },
            ],
            submitLabel: 'Add',
        });
        if (!data) return;
        const label = String(data.label || '').trim();
        if (!label) return;
        const id = slugify(label);
        let cb = String(data.central_bank || '');
        if (cb === '__new__') {
            cb = await this._createBankArchetypeInline();
            if (cb == null) return;   // user cancelled the sub-dialog
        }
        const res = await window.pywebview?.api?.country_add?.(
            id, label, String(data.currency || ''), cb || null,
        );
        if (res && res.ok === false) {
            this.logger.warn?.('country_add failed', res.error);
            return;
        }
        await this._refresh();
    }

    async _onEditCountry(id) {
        const co = this._countries.find((c) => c.id === id);
        if (!co) return;
        const data = await openForm({
            title: `Edit country "${co.label || id}"`,
            fields: [
                { name: 'label', label: 'Country name', type: 'text', default: co.label || '' },
                { name: 'currency', label: 'Currency', type: 'select',
                  default: co.currency || '',
                  options: this._currencies.map((c) => ({
                      value: c.id, label: `${c.id} — ${c.label || c.id}`,
                  })) },
                { name: 'central_bank', label: 'Central bank agent', type: 'select',
                  options: this._cbOptions(), default: co.central_bank || '' },
            ],
            submitLabel: 'Save',
        });
        if (!data) return;
        let cb = String(data.central_bank || '');
        if (cb === '__new__') {
            cb = await this._createBankArchetypeInline();
            if (cb == null) return;
        }
        await window.pywebview?.api?.country_update?.(
            id,
            String(data.label ?? co.label ?? ''),
            String(data.currency ?? co.currency ?? ''),
            cb || null,
        );
        await this._refresh();
    }

    async _onRemoveCountry(id) {
        const used = this._sectors.some((s) => s.country === id);
        if (used) {
            await openConfirm({
                title: `Cannot remove "${id}"`,
                message: 'Sectors still reference this country. Reassign them first (SFC sidebar) before removing.',
                confirmLabel: 'OK',
            });
            return;
        }
        const ok = await openConfirm({
            title: `Remove country "${id}"`,
            confirmLabel: 'Remove', danger: true,
        });
        if (!ok) return;
        await window.pywebview?.api?.country_remove?.(id);
        await this._refresh();
    }

    /** Inline sub-dialog launched by the "+ Create new bank archetype…"
     *  option in the country form's CB picker. Returns the new
     *  archetype's id on success, or null if the user cancelled. */
    async _createBankArchetypeInline() {
        const data = await openForm({
            title: 'New bank agent',
            fields: [
                { name: 'label', label: 'Display label', type: 'text', required: true,
                  placeholder: 'e.g. Central Bank' },
                { name: 'default_sector', label: 'Default sector', type: 'select',
                  required: true,
                  default: this._defaultBankSector(),
                  options: this._sectors.map((s) => ({
                      value: s.id, label: `${s.id} — ${s.label || s.id}`,
                  })) },
                { name: 'population', label: 'Population', type: 'number',
                  default: 1, step: '1' },
            ],
            submitLabel: 'Create',
        });
        if (!data) return null;
        const label = String(data.label || '').trim();
        if (!label) return null;
        const aid = label.toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 64);
        if (!aid) return null;
        const res = await window.pywebview?.api?.agent_add?.(
            aid, label,
            String(data.default_sector || ''),
            Number(data.population || 1),
            'bank',
        );
        if (res && res.ok === false) {
            this.logger.warn?.('agent_add failed', res.error);
            return null;
        }
        // Refresh local archetype list so subsequent CB-picker reads
        // include the new bank.
        try {
            const list = await window.pywebview?.api?.agents_list?.() ?? [];
            this._archetypes = Array.isArray(list) ? list : [];
        } catch { /* ignore */ }
        return aid;
    }

    // ------------------------------------------------------------- card: fx

    _renderFx() {
        const host = this.hostEl.querySelector('[data-host="fx"]');
        const summary = this.hostEl.querySelector('[data-host="fx-summary"]');
        if (!host || !summary) return;
        if (!this._fxActive) {
            summary.textContent = '';
            host.innerHTML = `<p class="ea-card__empty">No live world — run or step the simulation to see live FX rates.</p>`;
            return;
        }
        if (this._fxPairs.length === 0) {
            summary.textContent = '';
            host.innerHTML = `<p class="ea-card__empty">No FX markets declared. Add an FX market under Markets to bridge two currencies.</p>`;
            return;
        }
        const pegs = this._fxPairs.filter((p) => p.peg);
        const breached = pegs.filter((p) => p.peg && p.peg.status && p.peg.status !== 'inside');
        summary.innerHTML = `
            <span>${this._fxPairs.length} pair${this._fxPairs.length === 1 ? '' : 's'}</span>
            <span class="ea-badge ea-badge--muted">${pegs.length} pegged</span>
            ${breached.length > 0
                ? `<span class="ea-badge ea-badge--bad">${breached.length} breached</span>`
                : (pegs.length > 0
                    ? `<span class="ea-badge ea-badge--ok">all inside corridor</span>`
                    : '')}
        `;
        const rows = this._fxPairs.map((p) => this._renderFxRowHtml(p)).join('');
        host.innerHTML = `
            <table class="ea-table ea-fx-table">
                <thead><tr>
                    <th>Pair</th><th>Countries</th>
                    <th class="ea-fx-num">Mid</th>
                    <th>Peg corridor</th>
                    <th class="ea-fx-num">Last volume</th>
                    <th class="ea-fx-num">Orders</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }

    _renderFxRowHtml(p) {
        const cbase  = p.country_base  ? esc(p.country_base)  : '<span class="ea-text--muted">—</span>';
        const cquote = p.country_quote ? esc(p.country_quote) : '<span class="ea-text--muted">—</span>';
        const mid = (p.mid == null)
            ? '<span class="ea-text--muted">no quote yet</span>'
            : esc(fmt4(p.mid));
        const pegCell = p.peg ? this._renderPegCellHtml(p.peg) : '<span class="ea-text--muted">free float</span>';
        return `
            <tr>
                <td><b>${esc(p.base)} / ${esc(p.quote)}</b><br><small class="ea-text--muted">${esc(p.market_id)}</small></td>
                <td>${cbase} → ${cquote}</td>
                <td class="ea-fx-num">${mid}</td>
                <td>${pegCell}</td>
                <td class="ea-fx-num">${esc(fmt2(p.last_volume))}</td>
                <td class="ea-fx-num"><span title="Buy orders">${p.n_buys}</span> / <span title="Sell orders">${p.n_sells}</span></td>
            </tr>
        `;
    }

    _renderPegCellHtml(peg) {
        const status = peg.status || 'inside';
        const cls = status === 'inside' ? 'ea-badge--ok' : 'ea-badge--bad';
        const label = ({
            inside: 'inside corridor',
            below_floor: '↓ below floor',
            above_ceiling: '↑ above ceiling',
        })[status] || status;
        const cb = peg.cb_country ? esc(peg.cb_country) : esc(peg.cb_archetype);
        return `
            <span class="ea-fx-peg">
                <span class="ea-fx-peg__range">[${esc(fmt4(peg.floor))} – <b>${esc(fmt4(peg.target))}</b> – ${esc(fmt4(peg.ceiling))}]</span>
                <span class="ea-badge ${cls}">${label}</span>
                <small class="ea-text--muted">CB: ${cb}</small>
            </span>
        `;
    }

    // -------------------------------------------------------- card: mtm

    _renderMtm() {
        const host = this.hostEl.querySelector('[data-host="mtm"]');
        if (!host) return;
        // The MtM registry lives on the live world model. When no live
        // world is up, fall back to "configure to see this" — the
        // valuator registry is fully derived, no project-config UI.
        if (!this._fxActive) {
            host.innerHTML = `<p class="ea-card__empty">Run the world to populate the valuator registry.</p>`;
            return;
        }
        host.innerHTML = `<p class="ea-card__hint">Active. Per-kind MtM details surface on the SFC overview's "By country" rollup.</p>`;
    }
}
