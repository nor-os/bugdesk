/**
 * parent_child_detail.js — shared building blocks for any detail tab
 * that represents a CHILD entity (variation, branch) under a parent
 * (base archetype, market).
 *
 * Both `agent_tab.js` (variations) and `market_tab.js` (branches) share
 * the same logical shape:
 *   - parent owns the code/contract; child inherits + overrides
 *   - attributes have an inheritance dimension (own / inherited /
 *     overridden) we should surface uniformly
 *   - signature comes from RELATIONSHIPS — what other entities require
 *     this entity to provide. Same widget on both kinds.
 *
 * Goal: any kind that has a parent-child split renders these three
 * blocks identically by construction. The host detail tab supplies
 * the data + click handlers; the rendering shape is owned here.
 *
 * Exports:
 *   - `renderParentChip(opts)` — header pill like "variation of X" /
 *     "branch of X" linking back to the parent.
 *   - `renderInheritanceTable(opts)` — child attributes with explicit
 *     source column (parent / own / override). Greys inherited rows.
 *   - `renderSignatureTable(opts)` — required methods + attributes
 *     derived from inbound relationships, plus the framework section.
 *   - `renderCodeOnParentHint(opts)` — "edit code on parent X" hint
 *     shown in place of the Code sub-tab on children.
 *
 * Each returns a HTML string. The host is responsible for inserting
 * + wiring `[data-action]` listeners. Keeping renderers pure makes
 * them trivially testable from JS-DOM or string assertions.
 */

import { esc } from './_util.js';


// ── Parent chip ────────────────────────────────────────────────────


/** `{ childKindLabel, parentKind, parentId, parentLabel }` */
export function renderParentChip({
    childKindLabel = 'variation',
    parentKind,
    parentId,
    parentLabel,
} = {}) {
    if (!parentId) return '';
    return `
        <span class="ea-parent-chip"
              title="This entity is a ${esc(childKindLabel)} of ${esc(parentId)}">
            <span class="material-symbols-outlined ea-parent-chip__icon">arrow_upward</span>
            <span class="ea-parent-chip__kind">${esc(childKindLabel)} of</span>
            <button type="button"
                    class="ea-parent-chip__link"
                    data-action="open-parent"
                    data-parent-id="${esc(parentId)}"
                    data-parent-kind="${esc(parentKind || '')}"
                    title="Open ${esc(parentLabel || parentId)}">
                <code>${esc(parentLabel || parentId)}</code>
            </button>
        </span>`;
}


// ── Inheritance table ──────────────────────────────────────────────


/** Render the child's attributes with each row tagged as `parent` (only
 *  on parent), `own` (only on child — additive), or `override` (on
 *  parent AND child, value differs). Inherited rows are greyed; the
 *  Source column carries the chip.
 *
 *  `opts.rows`: list of `{name, type, parentValue, childValue, source}`.
 *  Source is one of `'parent' | 'own' | 'override'`. Missing
 *  parentValue means inherited only; missing childValue means
 *  parent-only (rare — show as inherited).
 */
export function renderInheritanceTable({
    rows = [],
    emptyHint = 'No attributes declared yet.',
    title = 'Attributes',
} = {}) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return `<section class="ea-card">
            <h3 class="ea-card__title">${esc(title)}</h3>
            <p class="ea-card__hint ea-card__hint--show">${esc(emptyHint)}</p>
        </section>`;
    }
    const body = rows.map((r) => {
        const cls =
            r.source === 'override' ? ' ea-inherit-row--override' :
            r.source === 'own'      ? ' ea-inherit-row--own'      :
                                      ' ea-inherit-row--inherited';
        const chip =
            r.source === 'override' ? `<span class="ea-chip ea-chip--override">override</span>` :
            r.source === 'own'      ? `<span class="ea-chip ea-chip--own">own</span>` :
                                      `<span class="ea-chip ea-chip--inherited">inherited</span>`;
        const parentCell = r.parentValue !== undefined && r.parentValue !== null
            ? `<code>${esc(String(r.parentValue))}</code>` : '<span class="ea-inherit-dim">—</span>';
        const childCell = r.childValue !== undefined && r.childValue !== null
            ? `<code>${esc(String(r.childValue))}</code>`  : '<span class="ea-inherit-dim">—</span>';
        return `<tr class="ea-inherit-row${cls}">
            <td><code>${esc(r.name || '')}</code></td>
            <td><span class="ea-inherit-type">${esc(r.type || 'any')}</span></td>
            <td>${parentCell}</td>
            <td>${childCell}</td>
            <td>${chip}</td>
        </tr>`;
    }).join('');
    return `<section class="ea-card">
        <h3 class="ea-card__title">${esc(title)}</h3>
        <table class="ea-inherit-table">
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Parent value</th>
                    <th>Child value</th>
                    <th>Source</th>
                </tr>
            </thead>
            <tbody>${body}</tbody>
        </table>
    </section>`;
}


/** Compute inheritance rows given parent + child attribute arrays.
 *  Each attribute carries `{name, type, default, value?}`. Override
 *  detection compares `value` (or `default`) on both sides. */
export function computeInheritanceRows(parentAttrs = [], childAttrs = []) {
    const parentMap = new Map();
    for (const a of (parentAttrs || [])) {
        if (a?.name) parentMap.set(a.name, a);
    }
    const childMap = new Map();
    for (const a of (childAttrs || [])) {
        if (a?.name) childMap.set(a.name, a);
    }
    const out = [];
    const seen = new Set();
    for (const [name, p] of parentMap) {
        const c = childMap.get(name);
        const pv = (p?.value !== undefined) ? p.value : p?.default;
        const cv = c ? ((c.value !== undefined) ? c.value : c.default) : undefined;
        const source = c
            ? (String(pv) === String(cv) ? 'parent' : 'override')
            : 'parent';
        out.push({
            name, type: p?.type || c?.type || 'any',
            parentValue: pv, childValue: cv, source,
        });
        seen.add(name);
    }
    for (const [name, c] of childMap) {
        if (seen.has(name)) continue;
        const cv = (c?.value !== undefined) ? c.value : c?.default;
        out.push({
            name, type: c?.type || 'any',
            parentValue: undefined, childValue: cv, source: 'own',
        });
    }
    return out;
}


// ── Signature table ────────────────────────────────────────────────


/** Render the signature derived from inbound relationships + framework
 *  contracts. `opts.signature` is the wire shape from
 *  `bridge.entity_signature(kind, id)`.
 */
export function renderSignatureTable({
    signature,
    emptyHint = (
        'No inbound dependencies declared. Other entities will declare '
        + 'what they need from this one in their Relationships.'
    ),
} = {}) {
    const framework = (signature?.framework || []);
    const inbound   = (signature?.inbound   || []);
    const requiredMethods    = (signature?.required_methods    || []);
    const requiredAttributes = (signature?.required_attributes || []);
    const frameworkRows = framework.map((s) =>
        `<tr class="ea-sig-row ${s.required ? '' : 'ea-sig-row--optional'}">
            <td><code>${esc(s.name || '')}</code></td>
            <td>${esc(s.kind || 'method')}</td>
            <td>${esc(s.description || '')}</td>
            <td><span class="ea-chip ${s.required ? 'ea-chip--required' : 'ea-chip--optional'}">${s.required ? 'required' : 'optional'}</span></td>
        </tr>`,
    ).join('');
    const inboundRows = inbound.map((inb) => {
        const edgeChips = (inb.edges || []).map((e) => {
            const what = e.method ? `method:${e.method}`
                       : e.attribute ? `attr:${e.attribute}`
                       : e.account ? `account:${e.account}`
                       : e.edge;
            return `<span class="ea-chip ea-chip--edge">${esc(what)}</span>`;
        }).join(' ');
        return `<tr>
            <td><code>${esc(inb.id || '')}</code></td>
            <td>${esc(inb.kind || '')}</td>
            <td>${edgeChips || '<span class="ea-inherit-dim">—</span>'}</td>
        </tr>`;
    }).join('');
    const empty = framework.length === 0 && inbound.length === 0;
    if (empty) {
        return `<section class="ea-card">
            <h3 class="ea-card__title">Signature</h3>
            <p class="ea-card__hint ea-card__hint--show">${esc(emptyHint)}</p>
        </section>`;
    }
    return `
        ${framework.length ? `
            <section class="ea-card">
                <h3 class="ea-card__title">Framework contract</h3>
                <p class="ea-card__hint ea-card__hint--show">
                    Methods + attributes the engine guarantees against
                    this kind. The implementation lives on the parent
                    (or in its <code>code</code> column).
                </p>
                <table class="ea-sig-table">
                    <thead><tr>
                        <th>Name</th><th>Kind</th><th>Description</th><th>Required</th>
                    </tr></thead>
                    <tbody>${frameworkRows}</tbody>
                </table>
            </section>
        ` : ''}
        ${inbound.length ? `
            <section class="ea-card">
                <h3 class="ea-card__title">Inbound dependencies</h3>
                <p class="ea-card__hint ea-card__hint--show">
                    Other entities that depend on this one. The signature
                    here is the union of everything they touch — methods,
                    attributes, and accounts.
                </p>
                <table class="ea-sig-table">
                    <thead><tr>
                        <th>Caller</th><th>Kind</th><th>Touches</th>
                    </tr></thead>
                    <tbody>${inboundRows}</tbody>
                </table>
                ${requiredMethods.length || requiredAttributes.length ? `
                    <p class="ea-card__hint ea-card__hint--show">
                        Aggregate signature:
                        ${requiredMethods.length ? `
                            <strong>methods</strong>: ${requiredMethods.map((m) => `<code>${esc(m)}</code>`).join(', ')}.
                        ` : ''}
                        ${requiredAttributes.length ? `
                            <strong>attributes</strong>: ${requiredAttributes.map((a) => `<code>${esc(a)}</code>`).join(', ')}.
                        ` : ''}
                    </p>
                ` : ''}
            </section>
        ` : ''}
    `;
}


// ── Code-on-parent hint ────────────────────────────────────────────


/** Replaces the in-place Code editor on a child entity. The user clicks
 *  through to the parent's editor where the code actually lives. */
export function renderCodeOnParentHint({
    parentKindLabel = 'parent',
    parentId,
    parentLabel,
} = {}) {
    if (!parentId) {
        return `<section class="ea-card">
            <h3 class="ea-card__title">Code</h3>
            <p class="ea-card__hint ea-card__hint--show">
                This entity has no code body — it's a child with no parent.
            </p>
        </section>`;
    }
    return `<section class="ea-card">
        <h3 class="ea-card__title">Code lives on the ${esc(parentKindLabel)}</h3>
        <p class="ea-card__hint ea-card__hint--show">
            This entity inherits all behaviour from
            <button type="button"
                    class="ea-parent-link"
                    data-action="open-parent"
                    data-parent-id="${esc(parentId)}">
                <code>${esc(parentLabel || parentId)}</code>
            </button>.
            Edits to loop bodies / clearing code happen there.
        </p>
        <button type="button" class="ea-btn ea-btn--small"
                data-action="open-parent"
                data-parent-id="${esc(parentId)}">
            <span class="material-symbols-outlined">open_in_new</span>
            Open ${esc(parentLabel || parentId)}
        </button>
    </section>`;
}


// ── Implementation verdict ─────────────────────────────────────────


/** Render the implementation-vs-contract verdict.
 *
 *  Inputs:
 *    `child`     — `{label, attributes, parent}` for this entry.
 *    `parent`    — parent entry the contract derives from. Optional.
 *    `impl`      — `bridge.implementation_percent` payload
 *                  (`{percent, attrs_total, attrs_implemented,
 *                  methods_total, methods_implemented, methods_complete,
 *                  has_parent}`). Required.
 *    `scan`      — `bridge.entity_scan_methods` payload
 *                  (`{scanned, declared, diff: {match, override,
 *                  missing, extra}}`). Optional — when present, the
 *                  method buckets render alongside the attribute
 *                  table for an at-a-glance verdict per signature.
 *    `parentKindLabel` — UI label for the parent kind (e.g. "agent",
 *                  "market"). Defaults to "parent".
 *
 *  The shape mirrors the legacy `_openContractWindow` ManagedWindow
 *  contents (agents_landing.js). Lifted here so both the Implementation
 *  sub-tab and the landing's right-click "Contract detail" share one
 *  renderer.
 */
export function renderImplementationVerdict({
    child,
    parent,
    impl,
    scan,
    parentKindLabel = 'parent',
} = {}) {
    if (!impl || impl.has_parent === false) {
        return `<section class="ea-card">
            <h3 class="ea-card__title">Implementation</h3>
            <p class="ea-card__hint ea-card__hint--show">
                This entity has no parent — every method and attribute
                it carries IS the contract. Implementation status
                applies to its children.
            </p>
        </section>`;
    }
    const pct  = Number(impl.percent || 0);
    const hue  = Math.max(0, Math.min(120, Math.round(pct * 1.2)));
    const okM  = !!impl.methods_complete;
    const parentLabel = parent?.label || parent?.id || 'parent';

    // Per-attribute breakdown — every name from parent OR child.
    const names = new Set();
    for (const a of (parent?.attributes  || [])) if (a?.name) names.add(a.name);
    for (const a of (child?.attributes   || [])) if (a?.name) names.add(a.name);
    const attrRows = [...names].sort().map((name) => {
        const p = (parent?.attributes || []).find((a) => a.name === name);
        const v = (child?.attributes  || []).find((a) => a.name === name);
        const pVal = p ? ((p.value ?? p.default) ?? null) : null;
        const vVal = v ? ((v.value ?? v.default) ?? null) : null;
        const overridden = !!v
            && (vVal !== null && vVal !== undefined)
            && String(vVal) !== String(pVal ?? '');
        const cls = !p ? 'is-extra'
                  : !v ? 'is-inherited'
                  : overridden ? 'is-mismatch' : 'is-ok';
        const declaredType = p?.type || '—';
        const pCell = p
            ? `<code>${esc(String(pVal ?? ''))}</code>`
            : '<span class="ea-contract-detail__none">— (own)</span>';
        const vCell = overridden
            ? `<code>${esc(String(vVal ?? ''))}</code>`
            : (v
                ? '<span class="ea-contract-detail__none">— (inherited)</span>'
                : '<span class="ea-contract-detail__none">— (missing)</span>');
        return `
            <tr class="${cls}">
                <td><code>${esc(name)}</code>${
                    p?.required ? ' <span class="ea-contract-detail__req">required</span>' : ''
                }</td>
                <td><code>${esc(declaredType)}</code></td>
                <td>${pCell}</td>
                <td>${vCell}</td>
            </tr>`;
    }).join('');

    // Method buckets — only render when scan data was passed.
    const methodSection = scan
        ? `<section class="ea-card">
                <h3 class="ea-card__title">Methods</h3>
                ${_renderMethodBuckets(scan)}
            </section>`
        : '';

    return `
        <section class="ea-card">
            <h3 class="ea-card__title">Implementation</h3>
            <p class="ea-card__hint ea-card__hint--show">
                Verdict for <code>${esc(child?.label || child?.id || '?')}</code>
                against ${esc(parentKindLabel)}
                <code>${esc(parentLabel)}</code>.
                <span style="color: hsl(${hue} 65% 50%); font-weight: 600;">${pct}%</span>
                of ${impl.attrs_total} required attribute${impl.attrs_total === 1 ? '' : 's'} carried.
                ${impl.methods_total > 0
                    ? `Methods: ${impl.methods_implemented}/${impl.methods_total} ${okM
                        ? '<span class="ea-contract-detail__verdict ea-contract-detail__verdict--ok">✓ complete</span>'
                        : '<span class="ea-contract-detail__verdict ea-contract-detail__verdict--fail">✗ incomplete</span>'}.`
                    : ''}
            </p>
            <table class="ea-contract-detail__table">
                <thead><tr>
                    <th>Attribute</th>
                    <th>Type</th>
                    <th>Parent default</th>
                    <th>This entry</th>
                </tr></thead>
                <tbody>${attrRows || '<tr><td colspan="4">No attributes on either side.</td></tr>'}</tbody>
            </table>
        </section>
        ${methodSection}`;
}


// ── Inherited-from toggle widget ────────────────────────────────────


/** Mount an informational "inherited from X" label above an editor.
 *
 *  A variant/branch always has its own real, editable code file that
 *  subclasses its parent (agents: `agent_add`/`entity_code_path`; markets:
 *  the branch's own class) — there's no separate forked/unforked file state
 *  to toggle, so this is display-only. `opts`:
 *    parentLabel       — id / label of the parent (e.g. "banker")
 *    parentKindLabel   — UI noun (e.g. "agent", "market")
 *
 *  Returns `{ destroy() }`.
 */
export function mountInheritedToggle(host, opts = {}) {
    if (!host) return { destroy() {} };
    const { parentLabel = '', parentKindLabel = 'parent' } = opts;
    const row = document.createElement('div');
    row.className = 'ea-inherited-toggle';
    row.innerHTML = `
        <span class="ea-inherited-toggle__text">
            Variation of ${esc(parentKindLabel)} <code>${esc(parentLabel)}</code>
        </span>
    `;
    host.appendChild(row);
    return {
        destroy() {
            try { row.remove(); } catch { /* ignore */ }
        },
    };
}


function _renderMethodBuckets(scan) {
    const diff = scan?.diff || {};
    const matched   = diff.match    || [];
    const overrides = diff.override || [];
    const missing   = diff.missing  || [];
    const extra     = diff.extra    || [];
    const bucket = (rows, cls, label) => rows.length === 0 ? '' : `
        <div class="ea-impl-bucket ea-impl-bucket--${esc(cls)}">
            <div class="ea-impl-bucket__head">${esc(label)} (${rows.length})</div>
            <ul>${rows.map((m) => `
                <li>
                    <code>${esc(m.signature || m.name || '')}</code>
                    ${m.diagnostic ? `<span class="ea-live-sig__desc">${esc(m.diagnostic)}</span>` : ''}
                </li>`).join('')}</ul>
        </div>`;
    return `
        ${bucket(matched,   'ok',       '✓ Satisfies contract')}
        ${bucket(overrides, 'override', '◆ Signature drift')}
        ${bucket(missing,   'missing',  '✗ Missing from code')}
        ${bucket(extra,     'extra',    '⊕ Not in declared contract')}
    `;
}
