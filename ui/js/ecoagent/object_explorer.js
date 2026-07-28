/**
 * object_explorer.js — right-panel project reference.
 *
 * IDE-style tree of every user-editable thing in the project. Each
 * category expands to a list of items; each item expands to its
 * members in a property-grid layout (name · type · value). All names
 * are text-selectable for copy/paste. A top filter narrows the tree
 * to items + members matching the query.
 *
 * **Data fetch is delegated to `entity_sources.js`** so the explorer,
 * the command palette, and any future search surface share one
 * source of truth for "what entities exist in this project". Adding a
 * new category means: (1) a record in `ENTITY_SOURCES`, (2) a node
 * builder + entry in `CATEGORIES` below. The hand-rolled fetch this
 * panel used to do drifted out of date — it never knew about agents,
 * scenarios, dashboards, KPIs, or market archetypes.
 */

import { loadEntitiesGrouped } from '../tiling/entity_sources.js';

const BOX_ID = 'object-explorer';
// Persist expand state across refreshes so live ticks / project events
// don't collapse the user's tree.
const _expanded = new Map();    // node id → bool

// Raw bridge rows keyed by navKind, populated from loadEntitiesGrouped.
// Initialized empty; `_reload` repopulates on each refresh tick.
let _grouped = {};
let _filter  = '';
let _wm      = null;

// Item-id prefix → the registered openable tab kind (page_stubs.js), so the
// per-item "open" button loads the right editor in the main tile.
const OE_OPEN_KIND = {
    archetype: 'archetype',                 // agent
    'market-archetype': 'market-archetype', // concrete market
    kind: 'asset_kind',                     // concrete asset (id `kind:<asset>`)
    scenario: 'scenario',
    dashboard: 'dashboard',
    kpi: 'kpi',
    // sector-kind / cat have no direct editor — no open button.
};

/** `{kind, id}` to open for an explorer item id (`<prefix>:<id>`), or null. */
function _openTarget(itemId) {
    const s = String(itemId || '');
    const i = s.indexOf(':');
    if (i < 0) return null;
    const kind = OE_OPEN_KIND[s.slice(0, i)];
    const id = s.slice(i + 1);
    return (kind && id) ? { kind, id } : null;
}


export function installObjectExplorer({ eventBus, logger, wm } = {}) {
    _wm = wm || _wm;
    const log = logger ?? { warn(){}, error(){}, debug(){} };
    const body = document.querySelector('.panel.right .right-panel-body');
    if (!body) return null;
    if (body.querySelector(`[data-collapsible-id="${BOX_ID}"]`)) return null;

    const box = document.createElement('div');
    box.className = 'collapsible-box';
    box.dataset.collapsibleId = BOX_ID;
    box.dataset.collapsibleDefault = 'expanded';
    box.dataset.collapsibleGroup = 'right-sections';
    box.innerHTML = `
        <div class="collapsible-header" data-collapsible-header="true">
            <button class="arrow-toggle" type="button">
                <span class="collapsible-arrow material-symbols-outlined">expand_more</span>
            </button>
            <span>Object Explorer</span>
        </div>
        <div class="collapsible-content visible" data-collapsible-content="true">
            <div class="ea-oe-controls">
                <span class="material-symbols-outlined ea-oe-controls__icon">search</span>
                <input type="search" class="ea-oe-controls__filter"
                       placeholder="Filter classes / members…"
                       data-role="filter">
            </div>
            <div class="ea-object-explorer" data-role="host">
                <div class="ea-object-explorer__empty">Loading…</div>
            </div>
        </div>
    `;

    // Object Explorer is the sole EcoAgent-owned right-panel section now
    // (the Agent API cheatsheet moved into the agent page's SlideOutPanel),
    // so we just park it at the top of the right-panel body.
    body.insertBefore(box, body.firstChild);

    const host = box.querySelector('[data-role="host"]');
    const filterInput = box.querySelector('[data-role="filter"]');

    // Collapse / expand wiring.
    //
    // History: prior attempts used the same `.visible` class toggle the
    // shell uses elsewhere, but something in the right-panel layout was
    // keeping the content laid out anyway (likely a CSS specificity loss
    // for the OE box specifically). Using INLINE `style.display` makes
    // the collapse unconditional — no class, no specificity, no
    // observer can override it.
    //
    // Click is captured at the box level (not the header) and runs in
    // the capture phase, so it fires before any other listener that
    // might re-toggle. State is persisted to the same
    // `ecosim.collapsibleState.v1` store the shell uses, so the choice
    // survives reload.
    const headerEl  = box.querySelector('[data-collapsible-header="true"]');
    const contentEl = box.querySelector('[data-collapsible-content="true"]');
    const arrowEl   = box.querySelector('.collapsible-arrow');

    const applyState = (expanded) => {
        if (contentEl) {
            contentEl.classList.toggle('visible', !!expanded);
            // Inline style wins over any CSS class — bulletproof.
            contentEl.style.display = expanded ? '' : 'none';
        }
        if (arrowEl) arrowEl.classList.toggle('collapsed', !expanded);
        box.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        // Mirror state on a data attribute so anyone (debugger, tests,
        // future siblings) can read it without reaching into the DOM.
        box.dataset.collapsibleExpanded = expanded ? 'true' : 'false';
    };

    // Hydrate from the shared store; default to expanded so a fresh
    // user sees the project tree without having to dig for it.
    let expandedState = _readPersistedExpand(BOX_ID, /*defaultExpanded*/ true);
    applyState(expandedState);

    if (headerEl) headerEl.style.cursor = 'pointer';

    // Capture-phase listener on the box itself — anything inside the
    // header triggers it, anything inside the content doesn't. This
    // also pre-empts any other listener (e.g. a late call to
    // `_wireCollapsibleEvents`) from binding a competing toggle.
    box.addEventListener('click', (e) => {
        if (!headerEl) return;
        if (!headerEl.contains(e.target)) return;          // click inside content
        if (e.target.closest('input')) return;
        const innerBtn = e.target.closest('button');
        if (innerBtn && !innerBtn.classList.contains('arrow-toggle')) return;
        expandedState = !expandedState;
        applyState(expandedState);
        _writePersistedExpand(BOX_ID, expandedState);
    }, /*useCapture*/ true);

    filterInput.addEventListener('input', () => {
        _filter = filterInput.value.trim().toLowerCase();
        _paint(host);
    });

    const refresh = () => _reload(host, log);
    eventBus?.on?.('ecoagent:project:changed', refresh);
    eventBus?.on?.('extra-mode:changed', refresh);
    eventBus?.on?.('ecoagent:run:completed', refresh);
    refresh();

    return { box, refresh };
}


// ── Data fetch + paint ──────────────────────────────────────────────────────

async function _reload(host, log) {
    if (!host) return;
    try {
        _grouped = await loadEntitiesGrouped(window.pywebview?.api);
    } catch (err) {
        log.warn?.('object explorer fetch failed', { err });
        _grouped = {};
    }
    _paint(host);
}

/** Categories shown in the explorer, in display order.
 *
 *  `navKind` keys into the grouped fetch output. `nodeBuilder` shapes
 *  one raw row into the explorer's node record (`{id, label, sub,
 *  chip, body, haystack}`). New entity types: drop one record in
 *  `ENTITY_SOURCES` and one entry here — no edits inside `_paint`.
 *
 *  Categories whose backing source is empty are hidden so the tree
 *  stays tight (cf. `_renderCategory`). */
const CATEGORIES = [
    // One node per domain. The TYPE definitions are the higher level
    // (top-level items); variants + runtime instances fold in underneath
    // as drill-down sections (P5 — no standalone "Archetypes"/"instances"
    // sibling categories).
    { navKind: 'archetype',        label: 'Agents',        icon: 'precision_manufacturing', defaultExpanded: true,
      // Bases only at the top level — variants nest under their parent.
      itemsFrom: (all) => (all.archetype || []).filter((a) => !a.parent),
      build:   (row, all) => _agentDomainNode(row, all) },
    { navKind: 'sector',           label: 'Sectors',           icon: 'account_balance',
      // Two-tier like agents/markets: higher level = sector KIND (derived
      // from the sub-sectors' `kind`); each drills into its sub-sectors.
      itemsFrom: (all) => {
          const subs = all.sector || [];
          const seen = new Set();
          const kinds = [];
          for (const s of subs) {
              const k = s.kind || 'real';
              if (seen.has(k)) continue;
              seen.add(k); kinds.push({ id: k, kind: k });
          }
          return kinds;
      },
      build:   (row, all) => _sectorDomainNode(row, all) },
    { navKind: 'asset_kind',       label: 'Assets',       icon: 'category',
      build:   (row, all) => _assetKindNode(row) },
    { navKind: 'market-archetype', label: 'Markets', icon: 'storefront',
      build:   (row, all) => _marketDomainNode(row, all) },
    { navKind: 'scenario',         label: 'Scenarios',         icon: 'science',
      build:   (row, all) => _scenarioNode(row) },
    { navKind: 'dashboard',        label: 'Dashboards',        icon: 'monitoring',
      build:   (row, all) => _dashboardNode(row) },
    { navKind: 'kpi',              label: 'KPIs',              icon: 'analytics',
      build:   (row, all) => _kpiNode(row) },
];

function _paint(host) {
    if (!host) return;
    const f = _filter;
    const cats = CATEGORIES.map((c) => {
        // `itemsFrom` lets a domain pick its higher-level rows from the
        // grouped fetch (e.g. Agents shows base archetypes only — variants
        // + instances fold in underneath). Defaults to the raw navKind list.
        const rows = c.itemsFrom ? (c.itemsFrom(_grouped) || [])
                                 : (_grouped[c.navKind] || []);
        return {
            id:    `cat:${c.navKind}`,
            label: c.label,
            icon:  c.icon,
            defaultExpanded: !!c.defaultExpanded,
            items: rows.map((row) => c.build(row, _grouped)),
        };
    });

    const html = cats
        .map((cat) => _renderCategory(cat, f))
        .filter(Boolean)
        .join('');

    host.innerHTML = html
        || `<div class="ea-object-explorer__empty">${
            f ? 'No matches.' : 'No entities — open a project to populate the tree.'
           }</div>`;
    _wireExpanders(host);
}


// ── Category / item render ──────────────────────────────────────────────────

function _renderCategory(cat, filter) {
    if (!_categoryShouldRender(cat, filter)) return '';
    const visibleItems = cat.items.filter((it) => _itemMatches(it, filter));
    if (filter && visibleItems.length === 0) return '';
    // When filtering, force-expand any category with matches so the user
    // actually sees them.
    const forced = filter && visibleItems.length > 0;
    const expanded = forced || _isExpanded(cat.id, cat.defaultExpanded);
    const body = visibleItems.length === 0
        ? `<div class="ea-oe-member ea-oe-member--empty">— none —</div>`
        : visibleItems.map((it) => _renderItem(it, filter)).join('');

    return `
        <div class="ea-oe-node ea-oe-node--cat${expanded ? ' ea-oe-node--expanded' : ''}"
             data-oe-id="${esc(cat.id)}" data-oe-default="${cat.defaultExpanded ? '1' : ''}">
            <div class="ea-oe-node__header">
                <span class="material-symbols-outlined ea-oe-node__chevron">chevron_right</span>
                <span class="material-symbols-outlined ea-oe-node__icon">${esc(cat.icon)}</span>
                <span class="ea-oe-node__label">${esc(cat.label)}</span>
                <span class="ea-oe-node__count">${cat.items.length}</span>
            </div>
            <div class="ea-oe-node__body">${body}</div>
        </div>
    `;
}

function _renderItem(item, filter) {
    // When filtering, force-expand items so matching members are visible.
    const forced = !!filter;
    const expanded = forced || _isExpanded(item.id, false);
    const open = _openTarget(item.id);
    const openBtn = open
        ? `<button type="button" class="ea-oe-node__open" title="Open in main"
                   data-oe-open-kind="${esc(open.kind)}" data-oe-open-id="${esc(open.id)}">
               <span class="material-symbols-outlined">open_in_new</span>
           </button>`
        : '';
    return `
        <div class="ea-oe-node ea-oe-node--item${expanded ? ' ea-oe-node--expanded' : ''}"
             data-oe-id="${esc(item.id)}">
            <div class="ea-oe-node__header">
                <span class="material-symbols-outlined ea-oe-node__chevron">chevron_right</span>
                <span class="ea-oe-node__label">${esc(item.label)}</span>
                ${item.sub ? `<span class="ea-oe-node__sub">${esc(item.sub)}</span>` : ''}
                ${item.chip ? `<span class="ea-oe-node__chip">${esc(item.chip)}</span>` : ''}
                ${openBtn}
            </div>
            <div class="ea-oe-node__body">${item.body}</div>
        </div>
    `;
}


// ── Item builders (one per category) ────────────────────────────────────────

// Hide an empty category outright unless the user is filtering — keeps
// the rail tight on small projects.
function _categoryShouldRender(cat, filter) {
    if (filter) return true;            // _renderCategory does its own match
    return cat.items.length > 0;
}

// Agents domain — a base archetype is the higher level. Its mechanism
// (params/accounts/loops) plus the lower level (variants) and runtime
// instances all fold in underneath as drill-down sections.
function _agentDomainNode(a, all) {
    const params = a.params || [];
    const accounts = a.accounts || [];
    const loops = ['__init_brain__', 'run', 'observe', 'execute', 'adjust'];

    // Lower level — variants whose parent is this base.
    const variants = (all.archetype || []).filter((v) => v.parent === a.archetype);
    const variantIds = new Set([a.archetype, ...variants.map((v) => v.archetype)]);
    // Runtime instances of this def family (base or any of its variants).
    const instances = (all.agent || []).filter((i) => variantIds.has(i.archetype));

    const sections = [
        _section('Params', params.map((p) => ({
            name: p.name,
            type: p.type || 'any',
            sub: `= ${_formatDefault(p.default)}`,
            tooltip: _paramTooltip(p),
        }))),
        _section('Accounts', accounts.map((acc) => ({
            name: acc.label,
            type: acc.type || '?',
            sub: acc.asset_kind || '',
        }))),
        _section('Loops', loops.map((m) => ({
            name: m, type: 'method', sub: '',
        }))),
        _section('Variants', variants.map((v) => ({
            name: v.archetype,
            type: 'variant',
            sub: v.label || '',
        }))),
        _section('Instances', instances.map((i) => ({
            name: i.id,
            type: 'instance',
            sub: i.sector_id || i.sector || i.archetype || '',
        }))),
    ].join('');
    return {
        id: `archetype:${a.archetype}`,
        label: a.label || a.archetype,
        sub: a.archetype,
        chip: a.builtin ? 'built-in' : '',
        body: sections,
        // Searchable text — names of params/accounts/variants/instances
        // feed item-match so filtering finds the lower level too.
        haystack: [
            a.archetype, a.label,
            ...params.map((p) => p.name),
            ...accounts.map((acc) => acc.label),
            ...loops,
            ...variants.map((v) => `${v.archetype} ${v.label || ''}`),
            ...instances.map((i) => `${i.id} ${i.label || ''}`),
        ].join(' ').toLowerCase(),
    };
}

// Markets domain — a market type is the higher level; its branch/runtime
// instances (linked by `instance.archetype === type.id`) fold in below.
function _marketDomainNode(m, all) {
    const instances = (all.market || []).filter((i) => i.archetype === m.id);
    const sections = [
        _section('Meta', [
            { name: 'id',   type: 'string', sub: `"${m.id}"` },
            { name: 'kind', type: 'string', sub: `"${m.kind || ''}"` },
        ]),
        _section('Branches', instances.map((i) => ({
            name: i.instance || i.id,
            type: 'branch',
            sub: i.kind || '',
        }))),
    ].join('');
    return {
        id: `market-archetype:${m.id}`,
        label: m.label || m.id,
        sub:   m.kind || '',
        body:  sections,
        haystack: [
            m.id, m.label, m.kind,
            ...instances.map((i) => `${i.instance || i.id}`),
        ].filter(Boolean).join(' ').toLowerCase(),
    };
}

function _scenarioNode(s) {
    const sections = _section('Meta', [
        { name: 'id', type: 'string', sub: `"${s.id}"` },
        ...(s.description
            ? [{ name: 'description', type: 'string',
                 sub: _truncate(s.description, 60) }]
            : []),
    ]);
    return {
        id: `scenario:${s.id}`,
        label: s.label || s.id,
        sub:   s.id,
        body:  sections,
        haystack: [s.id, s.label, s.description || '']
            .join(' ').toLowerCase(),
    };
}

function _dashboardNode(d) {
    const sections = _section('Meta', [
        { name: 'id', type: 'string', sub: `"${d.id}"` },
    ]);
    return {
        id: `dashboard:${d.id}`,
        label: d.label || d.id,
        sub:   d.id,
        body:  sections,
        haystack: [d.id, d.label].filter(Boolean)
            .join(' ').toLowerCase(),
    };
}

function _kpiNode(k) {
    const sections = _section('Meta', [
        { name: 'id', type: 'string', sub: `"${k.id}"` },
        ...(k.country
            ? [{ name: 'country', type: 'string', sub: `"${k.country}"` }]
            : []),
        ...(k.expression
            ? [{ name: 'expression', type: 'string',
                 sub: _truncate(k.expression, 60) }]
            : []),
    ]);
    return {
        id: `kpi:${k.id}`,
        label: k.label || k.id,
        sub:   k.country ? `country ${k.country}` : 'global',
        body:  sections,
        haystack: [k.id, k.label, k.country, k.expression || '']
            .filter(Boolean).join(' ').toLowerCase(),
    };
}

// Sectors domain — a sector KIND is the higher level; its concrete
// sub-sectors (the leaf definitions) + the agents homed in them fold in
// underneath, mirroring agents (base → variants) and markets (type →
// branches).
function _sectorDomainNode(kindRow, all) {
    const kind = kindRow.kind || kindRow.id;
    const subs = (all.sector || []).filter((s) => (s.kind || 'real') === kind);
    const subIds = new Set(subs.map((s) => s.id));
    const agents = (all.archetype || [])
        .filter((a) => subIds.has(a.default_sector))
        .map((a) => ({ name: a.archetype, type: 'archetype', sub: a.label || '' }));
    const sections = [
        _section('Sub-sectors', subs.map((s) => ({
            name: s.id,
            type: 'sub_sector',
            sub: s.label || '',
        }))),
        _section('Agents', agents),
    ].join('');
    return {
        id: `sector-kind:${kind}`,
        label: kind,
        sub: `${subs.length} sub-sector${subs.length === 1 ? '' : 's'}`,
        body: sections,
        haystack: [
            kind,
            ...subs.map((s) => `${s.id} ${s.label || ''}`),
            ...agents.map((a) => a.name),
        ].join(' ').toLowerCase(),
    };
}

function _assetKindNode(k) {
    const sections = _section('Meta', [
        { name: 'id',    type: 'string', sub: `"${k.id}"` },
        ...(k.description
            ? [{ name: 'description', type: 'string', sub: _truncate(k.description, 60) }]
            : []),
    ]);
    return {
        id: `kind:${k.id}`,
        label: k.label || k.id,
        sub: k.id,
        body: sections,
        haystack: [k.id, k.label, k.description || ''].join(' ').toLowerCase(),
    };
}


// ── Section + member rendering ──────────────────────────────────────────────

function _section(title, rows) {
    if (!rows || rows.length === 0) {
        return `
            <div class="ea-oe-section">
                <div class="ea-oe-section__title">${esc(title)}</div>
                <div class="ea-oe-member ea-oe-member--empty">— none —</div>
            </div>`;
    }
    return `
        <div class="ea-oe-section">
            <div class="ea-oe-section__title">${esc(title)} (${rows.length})</div>
            ${rows.map(_memberRow).join('')}
        </div>`;
}

function _memberRow(r) {
    const tooltip = r.tooltip ? ` title="${esc(r.tooltip)}"` : '';
    return `
        <div class="ea-oe-member"${tooltip}>
            <span class="ea-oe-member__name">${esc(r.name)}</span>
            <span class="ea-oe-member__type">${esc(r.type)}</span>
            <span class="ea-oe-member__sub">${esc(r.sub || '')}</span>
        </div>`;
}


// ── Filter + expand state ───────────────────────────────────────────────────

function _itemMatches(item, filter) {
    if (!filter) return true;
    return item.haystack.includes(filter);
}

function _isExpanded(id, defaultExpanded) {
    if (_expanded.has(id)) return _expanded.get(id);
    return !!defaultExpanded;
}

function _wireExpanders(host) {
    host.querySelectorAll('.ea-oe-node__header').forEach((h) => {
        h.addEventListener('click', (ev) => {
            // Allow drag-selecting text inside labels without toggling.
            if (window.getSelection?.()?.toString?.()) return;
            // Don't toggle on action button clicks.
            if (ev.target.closest('button')) return;
            const node = h.parentElement;
            if (!node) return;
            const id = node.dataset.oeId;
            const def = node.dataset.oeDefault === '1';
            const cur = _isExpanded(id, def);
            _expanded.set(id, !cur);
            node.classList.toggle('ea-oe-node--expanded');
        });
    });
    // "Open in main" buttons — load the entity into the primary tile.
    host.querySelectorAll('[data-oe-open-kind]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const kind = btn.dataset.oeOpenKind;
            const id = btn.dataset.oeOpenId;
            if (!kind || !id) return;
            try {
                if (typeof _wm?.navigate === 'function') {
                    _wm.navigate(kind, { id }, { dest: 'main' });
                } else if (typeof _wm?.openInPrimary === 'function') {
                    _wm.openInPrimary(kind, { id });
                } else {
                    console.warn('[object-explorer] no wm to open', kind, id);
                }
            } catch (err) {
                console.error('[object-explorer] open failed', kind, id, err);
            }
        });
    });
}


// ── Helpers ─────────────────────────────────────────────────────────────────

function _paramTooltip(p) {
    const parts = [];
    if (p.type)             parts.push(`Type: ${p.type}`);
    if (p.default != null)  parts.push(`Default: ${_formatDefault(p.default)}`);
    if (p.min != null || p.max != null) {
        parts.push(`Range: [${p.min ?? '-∞'}, ${p.max ?? '∞'}]`);
    }
    if (Array.isArray(p.choices) && p.choices.length > 0) {
        parts.push(`Choices: ${p.choices.join(', ')}`);
    }
    return parts.join(' · ');
}

function _formatDefault(v) {
    if (v == null) return 'None';
    if (typeof v === 'string') return `"${v}"`;
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    return String(v);
}

function _truncate(s, n) {
    const str = String(s);
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}


// ── Persisted-expand helpers ────────────────────────────────────────────────
// Mirror the shell's collapsible store so toggling Object Explorer survives
// reloads, AND so the shell-level "expand all / collapse all" affordances
// see this box's state too.
const _COLLAPSIBLE_STORE_KEY = 'ecosim.collapsibleState.v1';

function _readCollapsibleStore() {
    try {
        if (typeof localStorage === 'undefined') return {};
        const raw = localStorage.getItem(_COLLAPSIBLE_STORE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
}

function _readPersistedExpand(id, defaultExpanded) {
    const store = _readCollapsibleStore();
    return (id in store) ? !!store[id] : !!defaultExpanded;
}

function _writePersistedExpand(id, expanded) {
    try {
        if (typeof localStorage === 'undefined') return;
        const store = _readCollapsibleStore();
        store[id] = !!expanded;
        localStorage.setItem(_COLLAPSIBLE_STORE_KEY, JSON.stringify(store));
    } catch { /* quota / blocked storage — non-fatal */ }
}
