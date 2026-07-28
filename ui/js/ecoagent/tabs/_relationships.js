/**
 * _relationships.js — shared Relationships sub-tab renderer.
 *
 * Single surface, two pieces of information:
 *
 *   1. "Inherits from" — a one-line link to the parent archetype
 *      when this entry has one. Just a hint; the Attributes tab
 *      shows the inheritance grammar in detail (badges, overrides).
 *   2. "Used by" — every entry that points at this one (as a parent,
 *      via a typed-ref attribute, or via a `requires` row). The
 *      Contract column flags consumers that miss required attributes;
 *      clicking the cell pops a ManagedWindow with the per-attribute
 *      diff so the user can read WHY a contract is OK or broken.
 *
 * An earlier iteration had a "References" / "Out-references" card that
 * bundled the parent link, typed-ref attributes, and `requires` rows
 * into one table. It didn't pay rent: the typed-ref attributes are
 * already in the Attributes tab, the parent link is already in the
 * editor header, and `requires` is engine plumbing. So the surface is
 * one card (Used-by) plus the small inherits-from header line.
 *
 * Reads the unified registry via `registry_list()` — no entity-specific
 * endpoint needed.
 */

import { DataTable } from '../../ui/components/data_table.js';
import { ManagedWindow } from '../../ui/components/managed_window.js';


function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}


// Map entity_kind → canonical editor tab. Adding a new editor here
// lights up click-through across every Relationships sub-tab.
//
// Registry entity_kinds: `agent_kind` (abstract base) + `agent` (concrete)
// + `agent_instance` (runtime). For markets: `market` (parent) + `branch`
// (variant) + `market_instance` (runtime).
const KIND_TO_TAB = {
    asset_kind:         'asset_kind',   // abstract asset kind (base mode)
    asset:              'asset_kind',   // registry kind for a concrete asset
    agent_kind:         'archetype',   // abstract agent kind (base archetype)
    agent:              'archetype',   // concrete agent
    agent_instance:     'agent',       // runtime instance
    branch:             'market',      // market branch
    market_instance:    'market',
    market:             'market',
    sector:             'sector',
    market_kind:        'market-archetype',
};


// Editor tabs invoke this component with their own frontend/legacy
// entity_kind (e.g. asset_kind_tab passes `asset_kind`, agent_tab passes
// `archetype`), but `registry_list()` returns the canonical REGISTRY kind
// (`asset`, `agent_kind`/`agent`, `asset_kind_base`). These alias groups
// let `canonicalKind` resolve the caller's vocabulary to the registry one, so
// the self-lookup, `parent` refs, and relation checks all line up. Without it
// the self-lookup misses and the whole tab reads empty.
const ALIAS_GROUPS = [
    ['asset', 'asset_kind'],
    ['agent_kind', 'agent', 'archetype'],
    ['market', 'market_archetype', 'market-archetype'],
    ['branch', 'market_instance'],
];


function canonicalKind(entries, entity_kind, id) {
    // An exact match keeps the caller's kind (markets already pass the
    // registry kind).
    if (entries.some((e) => e.entity_kind === entity_kind && e.id === id)) {
        return entity_kind;
    }
    const group = ALIAS_GROUPS.find((g) => g.includes(entity_kind));
    if (group) {
        const hit = entries.find(
            (e) => group.includes(e.entity_kind) && e.id === id);
        if (hit) return hit.entity_kind;
    }
    return entity_kind;
}


function navigateTo(workspaceTabs, entity_kind, id, label) {
    const tab = KIND_TO_TAB[entity_kind] || 'archetype_viewer';
    if (tab === 'archetype_viewer') {
        workspaceTabs?.openTab?.({
            kind: 'archetype_viewer',
            entityId: `${entity_kind}:${id}`,
            label: label || id,
        });
    } else {
        workspaceTabs?.openTab?.({
            kind: tab, entityId: id, label: label || id,
        });
    }
}


function findEntry(entries, ref) {
    if (!ref) return null;
    const [k, id] = String(ref).split(':', 2);
    if (!k || !id) return null;
    return entries.find((e) => e.entity_kind === k && e.id === id) || null;
}


function isRefType(t) {
    const s = String(t || '');
    return s.startsWith('ref:') || s.startsWith('list[ref:');
}


function refTarget(t) {
    const s = String(t || '');
    return s.startsWith('list[ref:') ? s.slice(9, -1) : s.slice(4);
}


function refValueList(a) {
    const v = (a.value !== undefined && a.value !== null) ? a.value : a.default;
    if (v === null || v === undefined || v === '') return [];
    return Array.isArray(v) ? v.map(String) : [String(v)];
}


/** Pop a ManagedWindow showing the per-attribute contract detail for
 *  one Used-by row: which slots this entry declares, which the
 *  consumer provides, and what's missing. ManagedWindow (not openModal)
 *  so the user can move + resize while comparing against other tabs. */
function _openContractDetail(self, row) {
    const body = document.createElement('div');
    body.className = 'ea-contract-detail';
    body.style.cssText = 'padding: 12px; overflow: auto; height: 100%;';
    const rows = (row.contractRows || []).map((c) => {
        const cls = !c.provided ? 'is-missing'
                  : (c.declared_type && c.provided_type
                     && c.declared_type !== c.provided_type)
                        ? 'is-mismatch'
                        : 'is-ok';
        return `
            <tr class="${cls}">
                <td><code>${esc(c.name)}</code>${
                    c.required ? ' <span class="ea-contract-detail__req">required</span>' : ''
                }</td>
                <td><code>${esc(c.declared_type)}</code></td>
                <td>${c.provided
                    ? `<code>${esc(c.provided_type || '?')}</code>`
                    : '<span class="ea-contract-detail__none">— missing —</span>'}</td>
                <td>${c.provided && c.provided_value !== null
                    ? `<code>${esc(String(c.provided_value))}</code>`
                    : '—'}</td>
            </tr>`;
    }).join('');
    body.innerHTML = `
        <p class="ea-contract-detail__hint">
            Contract: <code>${esc(self.entity_kind)}:${esc(self.id)}</code>
            ↔ <code>${esc(row.entity_kind)}:${esc(row.id)}</code>
            (${esc(row.relation)})
        </p>
        <table class="ea-contract-detail__table">
            <thead><tr>
                <th>Attribute</th>
                <th>Declared</th>
                <th>Provided</th>
                <th>Value</th>
            </tr></thead>
            <tbody>${rows || '<tr><td colspan="4">'
                + 'No required attributes declared.</td></tr>'}</tbody>
        </table>
        ${row.ok ? `
            <p class="ea-contract-detail__verdict ea-contract-detail__verdict--ok">
                ✓ Contract satisfied — every declared attribute is
                present on the consumer.
            </p>`
            : `<p class="ea-contract-detail__verdict ea-contract-detail__verdict--fail">
                ✗ Contract incomplete — ${row.missing.length} required
                attribute${row.missing.length === 1 ? '' : 's'} missing:
                ${row.missing.map((n) => `<code>${esc(n)}</code>`).join(', ')}
            </p>`}
    `;
    const win = new ManagedWindow({
        id: `contract-detail-${self.entity_kind}-${self.id}-${row.entity_kind}-${row.id}`,
        title: `Contract — ${self.entity_kind}:${self.id} ↔ ${row.entity_kind}:${row.id}`,
        icon: 'verified',
        content: body,
        defaultWidth: 720,
        defaultHeight: 520,
        minWidth: 480,
        minHeight: 320,
        canMaximize: true,
        canResize: true,
    });
    win.show();
}


/** Mount the Relationships sub-tab body into `hostEl`.
 *
 *  @param {HTMLElement} hostEl
 *  @param {object} opts
 *  @param {string} opts.entity_kind        — which kind is being edited.
 *  @param {string} opts.id                 — the entity's id.
 *  @param {object} [opts.workspaceTabs]    — for click-through routing.
 *  @returns {{destroy: function, refresh: function}}
 */
export async function mountRelationshipsTab(hostEl, opts) {
    const { entity_kind, id, workspaceTabs, skipIds = [] } = opts;
    // Caller-supplied filter: `[{entity_kind, id}, ...]` — rows
    // matching any entry are dropped from inbound results. Used by
    // the branch view to suppress self-references when the branch
    // delegates to this component for its parent's edges (#122).
    const _skipKeys = new Set(
        skipIds.filter((s) => s && s.entity_kind && s.id)
            .map((s) => `${s.entity_kind}:${s.id}`));
    const api = window.pywebview?.api;

    hostEl.innerHTML = `
        <div class="ea-rel-status" data-role="status-line"></div>
        <section class="ea-card ea-relationships-card ea-rel-inherits-card">
            <h3 class="ea-card__title">Inherits from</h3>
            <p class="ea-card__hint">
                The parent this entity extends — its kind / base. The
                Attributes tab shows the full per-row inheritance grammar.
            </p>
            <div data-role="inherits-host"></div>
        </section>
        <section class="ea-card ea-relationships-card">
            <h3 class="ea-card__title">Implemented by</h3>
            <p class="ea-card__hint">
                Entries that implement this entity's contract — children
                that inherit from it. The <em>Contract</em> column flags
                implementers that miss attributes this entry declares as
                required; click a row for the per-attribute detail.
            </p>
            <div data-role="implemented-by-host"></div>
        </section>
        <section class="ea-card ea-relationships-card">
            <h3 class="ea-card__title">Used by</h3>
            <p class="ea-card__hint">
                Entries that reference this one via a typed-ref attribute
                or an explicit <code>requires</code> edge — consumers,
                not implementers.
            </p>
            <div data-role="used-by-host"></div>
        </section>
        <section class="ea-card ea-relationships-card">
            <h3 class="ea-card__title">Uses</h3>
            <p class="ea-card__hint">
                Entries this one references — typed-ref attribute values
                and <code>requires</code> edges.
            </p>
            <div data-role="uses-host"></div>
        </section>
    `;

    let inTable  = null;

    const renderEmpty = (host, msg) => {
        if (!host) return;
        host.innerHTML =
            `<div class="ea-bp-placeholder__hint">${esc(msg)}</div>`;
    };

    const render = async () => {
        let entries = [];
        try { entries = (await api?.registry_list?.()) || []; }
        catch { entries = []; }
        // Resolve the caller's (possibly frontend/legacy) entity_kind to the
        // registry kind so the self-lookup + relation checks below match.
        const ek = canonicalKind(entries, entity_kind, id);
        const self = entries.find(
            (e) => e.entity_kind === ek && e.id === id);

        const inheritsHost = hostEl.querySelector('[data-role="inherits-host"]');
        const statusLine = hostEl.querySelector('[data-role="status-line"]');

        if (!self) {
            if (statusLine) statusLine.innerHTML = '';
            if (inheritsHost) renderEmpty(inheritsHost, 'No registry entry yet.');
            return;
        }

        // ─── Abstract / instantiates chip ─────────────────────────────
        // Self-describing kind-vs-concrete status (stamped on the registry
        // entry's metadata). A `kind` is abstract (a type — never instantiated);
        // a concrete entity instantiates exactly when deliberately enabled
        // (agents: a population; markets/assets: always exactly 1).
        if (statusLine) {
            const md = self.metadata || {};
            const md_abstract = md.abstract === true
                || ek === 'market_kind' || ek === 'asset_kind' || ek === 'agent_kind';
            const isAgent = (ek === 'agent');
            const pop = Number(md.population);
            let chip;
            if (md_abstract) {
                chip = `<span class="ea-rel-status__chip ea-rel-status__chip--abstract">
                            abstract kind</span>
                        <span class="ea-rel-status__note">a type — never instantiated; implemented by its children</span>`;
            } else if (md.instantiates === true) {
                const count = isAgent
                    ? (Number.isFinite(pop) ? ` · ${pop} instance${pop === 1 ? '' : 's'}` : '')
                    : ' · 1 instance';
                chip = `<span class="ea-rel-status__chip ea-rel-status__chip--concrete">
                            concrete${esc(count)}</span>`;
            } else {
                chip = `<span class="ea-rel-status__chip">concrete · not instantiated</span>
                        <span class="ea-rel-status__note">an intermediate type, or instantiation opted out</span>`;
            }
            statusLine.innerHTML = chip;
        }

        // ─── "Inherits from" card ─────────────────────────────────────
        // A prominent parent link (its kind / base) + click-through. When the
        // entity has no parent it IS a top-level type — say so explicitly
        // rather than leave the card blank, so abstract-kind vs concrete-child
        // is legible at a glance.
        const parent = self.parent ? findEntry(entries, self.parent) : null;
        if (inheritsHost) {
            if (self.parent) {
                const [pk, pid] = String(self.parent).split(':', 2);
                const label = parent?.label || pid;
                const broken = !parent;
                inheritsHost.innerHTML = broken
                    ? `<div class="ea-rel-inherits__row ea-rel-row__broken">
                           ⚠ <code>${esc(pk)}:${esc(pid)}</code> (missing)
                       </div>`
                    : `<button type="button" class="ea-rel-inherits__parent"
                               data-rel-parent title="Open ${esc(pk)}:${esc(pid)}">
                           <span class="material-symbols-outlined">arrow_upward</span>
                           <span class="ea-rel-inherits__name">${esc(label)}</span>
                           <code class="ea-rel-inherits__ref">${esc(pk)}:${esc(pid)}</code>
                           <span class="material-symbols-outlined ea-rel-inherits__open">open_in_new</span>
                       </button>`;
                if (!broken) {
                    inheritsHost.querySelector('[data-rel-parent]')
                        ?.addEventListener('click', () => {
                            navigateTo(workspaceTabs, pk, pid, label);
                        });
                }
            } else {
                const hasChildren = entries.some((e) => e.parent === `${ek}:${id}`);
                inheritsHost.innerHTML =
                    `<div class="ea-bp-placeholder__hint">${
                        hasChildren
                            ? 'Top-level type — no parent. It defines the '
                              + 'contract its children (below) inherit.'
                            : 'No parent — inherits directly from the system '
                              + 'base class.'}</div>`;
            }
        }

        // ─── Used by (inverse refs) ──────────────────────────────
        const myRef = `${ek}:${id}`;
        const declaredAttrs = (self.attributes || [])
            .filter((a) => a.required).map((a) => a.name);
        const expectedAttrs = declaredAttrs.length > 0
            ? declaredAttrs
            : (self.attributes || []).map((a) => a.name);

        const inRows = [];
        for (const e of entries) {
            if (e.entity_kind === ek && e.id === id) continue;
            if (_skipKeys.has(`${e.entity_kind}:${e.id}`)) continue;
            // A typed-ref / requires edge may name this entity by any kind in
            // its alias group (frontend `asset_kind` vs registry `asset`), so
            // match against the whole group, not just the canonical kind.
            const myGroup = ALIAS_GROUPS.find((g) => g.includes(ek)) || [ek];
            const kindMatches = (k) => myGroup.includes(k);
            let relation = null;
            if (e.parent === myRef) {
                relation = 'inherits from';
            } else {
                for (const a of (e.attributes || [])) {
                    if (!isRefType(a.type)) continue;
                    if (!kindMatches(refTarget(a.type))) continue;
                    const ids = refValueList(a);
                    if (ids.includes(id)) {
                        relation = `references via ${a.name}`;
                        break;
                    }
                }
                if (!relation
                    && (e.requires || []).some((r) =>
                        kindMatches(r.kind) && r.id === id)) {
                    relation = `requires ${ek}:${id}`;
                }
                // Asset_kind has two canonical paths that aren't typed-
                // ref attributes — the generic walk above misses both,
                // so the Relationships tab reads empty for every
                // asset_kind. Explicit checks (#125, refined per #126):
                //
                //   1. Trading: walk `market` entries (the user-visible
                //      market parents like `goods`, `fx`, `labor`),
                //      look up each one's parent `market_kind` via
                //      `parent === 'market_kind:<id>'`, and check
                //      whether THAT kind's `supports_assets`
                //      includes this asset. Surfacing the market PARENT
                //      (not the underlying protocol class) is what the
                //      user thinks of as "markets that trade me".
                //   2. Holding: `agent` accounts
                //      carry an `asset_kind: <id>` for every account
                //      holding the asset — same as before.
                if (!relation && ek === 'asset'
                        && e.entity_kind === 'market') {
                    const parentRef = String(e.parent || '');
                    if (parentRef.startsWith('market_kind:')) {
                        const mkId = parentRef.slice('market_kind:'.length);
                        const mk = entries.find((x) =>
                            x.entity_kind === 'market_kind' && x.id === mkId);
                        const supports = mk?.metadata?.supports_assets || [];
                        if (Array.isArray(supports)
                                && (supports.includes(id) || supports.includes('*'))) {
                            relation = `trades (via ${mkId})`;
                        }
                    }
                }
                if (!relation && ek === 'asset') {
                    const accounts = e.metadata?.accounts || [];
                    if (Array.isArray(accounts)) {
                        for (const acc of accounts) {
                            if (acc && typeof acc === 'object'
                                    && acc.asset_kind === id) {
                                relation = acc.name
                                    ? `holds via ${acc.name}`
                                    : 'holds';
                                break;
                            }
                        }
                    }
                }
            }
            if (!relation) continue;
            const consumerAttrs = e.attributes || [];
            const got = new Set(consumerAttrs.map((a) => a.name));
            const missing = expectedAttrs.filter((n) => !got.has(n));
            // Per-attribute breakdown for the contract detail window.
            const contractRows = expectedAttrs.map((name) => {
                const declared = (self.attributes || [])
                    .find((a) => a.name === name) || {};
                const provided = consumerAttrs.find((a) => a.name === name);
                return {
                    name,
                    declared_type:  declared.type || '',
                    required:       !!declared.required,
                    provided:       !!provided,
                    provided_type:  provided?.type || '',
                    provided_value: provided
                        ? ((provided.value ?? provided.default) ?? null)
                        : null,
                };
            });
            inRows.push({
                entity_kind: e.entity_kind,
                id: e.id,
                label: e.label || e.id,
                relation,
                ok: missing.length === 0,
                missing,
                contractRows,
            });
        }

        // Split inRows into "Implemented by" (children that inherit
        // from this entity) vs "Used by" (entries referencing this
        // entity through typed-refs or `requires`).
        const implementedRows = inRows.filter((r) =>
            r.relation === 'inherits from');
        const usedRows = inRows.filter((r) =>
            r.relation !== 'inherits from');

        const mountTable = (host, rows, emptyMsg) => {
            try { host._table?.destroy?.(); } catch {}
            host._table = null;
            host.innerHTML = '';
            if (rows.length === 0) {
                host.innerHTML =
                    `<div class="ea-bp-placeholder__hint">${esc(emptyMsg)}</div>`;
                return null;
            }
            const tbl = new DataTable(host, {
                headers: ['Kind', 'Id', 'Label', 'Relation', 'Contract'],
                rows: rows.map((r) => [
                    r.entity_kind, r.id, r.label, r.relation,
                    r.ok ? 'OK' : `missing ${r.missing.length}`,
                ]),
                pageSize: 1000, pagination: false,
                sortable: true, filterable: true,
                // Selection chrome stays on; the row click handler
                // wired below opens the referenced entity. The
                // Contract cell's own click handler pops the
                // ManagedWindow contract view and stops propagation
                // so the row open doesn't fire on contract clicks.
                selectable: true, copyable: true,
                renderCell: (td, _v, colIdx, rowIdx) => {
                    const r = rows[rowIdx];
                    if (colIdx === 4) {
                        td.style.cursor = 'pointer';
                        td.title = 'Open contract view';
                        td.classList.add('ea-rel-contract-cell');
                        if (r.ok) {
                            td.innerHTML =
                                '<span class="ea-archetype-viewer__contract-ok">'
                                + '<span class="material-symbols-outlined">check_circle</span>'
                                + 'OK</span>';
                        } else {
                            td.innerHTML =
                                '<span class="ea-archetype-viewer__contract-fail">'
                                + '<span class="material-symbols-outlined">error</span>'
                                + esc(`missing ${r.missing.length}`)
                                + '</span>';
                        }
                        td.addEventListener('click', (e) => {
                            e.stopPropagation();
                            _openContractDetail(self, r);
                        });
                        return true;
                    }
                    return false;
                },
            });
            host._table = tbl;
            tbl.render();
            // Row-click anywhere except the Contract column opens the
            // referenced entity in its editor. The Contract cell's
            // own click handler (above) stops propagation, so a click
            // on the OK / missing chip pops the contract view instead.
            const tbody = host.querySelector('tbody');
            tbody?.addEventListener('click', (ev) => {
                if (ev.target.closest('.ea-rel-contract-cell')) return;
                if (ev.target.closest('button, a, input, select, textarea')) return;
                const tr = ev.target.closest('tr');
                if (!tr || !tbody.contains(tr)) return;
                const r = rows[tr.__rowIndex];
                if (r) navigateTo(workspaceTabs, r.entity_kind, r.id, r.label);
            });
            // Visual cue — the row reads as a navigation affordance.
            tbody?.querySelectorAll('tr').forEach((tr) => {
                tr.style.cursor = 'pointer';
            });
            return tbl;
        };

        // ─── Uses (forward refs) ─────────────────────────────────
        // Out-edges this entity declares: typed-ref attribute values
        // and `requires` rows.
        const usesRows = [];
        const _seenUses = new Set();
        const _pushUse = (kind, refId, relation) => {
            if (!kind || !refId) return;
            const key = `${kind}:${refId}`;
            if (_seenUses.has(key)) return;
            if (kind === entity_kind && refId === id) return;
            _seenUses.add(key);
            const target = findEntry(entries, key);
            usesRows.push({
                entity_kind: kind,
                id: refId,
                label: target?.label || refId,
                relation,
                ok: !!target,
                missing: target ? [] : ['(referenced entity not found)'],
                contractRows: [],
            });
        };
        for (const a of (self.attributes || [])) {
            if (!isRefType(a.type)) continue;
            const target = refTarget(a.type);
            for (const refId of refValueList(a)) {
                _pushUse(target, refId, `via ${a.name}`);
            }
        }
        for (const r of (self.requires || [])) {
            _pushUse(r?.kind, r?.id, `requires`);
        }

        try { inTable?.destroy?.(); } catch {}
        inTable = null;
        const implHost = hostEl.querySelector('[data-role="implemented-by-host"]');
        const usedHost = hostEl.querySelector('[data-role="used-by-host"]');
        const usesHost = hostEl.querySelector('[data-role="uses-host"]');
        if (implHost) {
            mountTable(implHost, implementedRows,
                'Nothing implements this entity yet.');
        }
        if (usedHost) {
            mountTable(usedHost, usedRows,
                'No consumers reference this entity yet.');
        }
        if (usesHost) {
            mountTable(usesHost, usesRows,
                'This entity has no outgoing references.');
        }
        inTable = implHost?._table || usedHost?._table || usesHost?._table || null;
    };

    await render();

    return {
        destroy() {
            try { inTable?.destroy?.(); } catch {}
            try { hostEl.querySelector('[data-role="implemented-by-host"]')
                ?._table?.destroy?.(); } catch {}
            try { hostEl.querySelector('[data-role="used-by-host"]')
                ?._table?.destroy?.(); } catch {}
            try { hostEl.querySelector('[data-role="uses-host"]')
                ?._table?.destroy?.(); } catch {}
        },
        refresh: render,
    };
}
