/**
 * live_signature_panel.js — the panel that sits above the Code editor
 * on both agent and market parents (and on variants / branches when
 * their code is unlocked from inheritance).
 *
 * Wire shape:
 *
 *   const panel = mountLiveSignaturePanel(host, {
 *     kind:     'agent',       // 'agent' | 'market'
 *     id:       'banker',
 *     editor:   monacoEditor,  // optional — listens for content changes
 *     vantage:  'outbound',    // 'outbound' (default) shows what THIS
 *                              //   code calls on others.
 *                              // 'inbound' shows what others require
 *                              //   THIS code to expose.
 *     getSource: () => editor.getValue(),
 *     logger,
 *   });
 *
 * Lifecycle:
 *
 *   - On mount: paint placeholder, fire two parallel fetches:
 *       1. bridge.entity_signature(kind, id)        — declared contract
 *       2. bridge.entity_scan_methods(kind, id)     — what the on-disk
 *                                                     file currently has
 *     When both resolve, render the method strip + drift warnings.
 *   - On editor content change (debounced 300ms): call
 *     entity_scan_methods({ source: editor.getValue() }) and re-render.
 *   - On destroy: dispose the editor listener.
 *
 * Visual: a vertical row list — one row per method, colour-coded by
 * bucket (match / override / extra / missing). Reuses the existing
 * `.ea-asset-kind-tab__api-row` CSS (one canonical row primitive).
 *
 *     ✓  __init_brain__(self)
 *     ◆  observe(self, ctx)            signature differs from parent
 *     ✗  adjust(self, ctx)             missing from your code
 *     ⊕  helper(self)
 *
 * Drift diagnostics live inline on the row instead of in a separate
 * details block — that's what the asset_kind_tab pattern does and what
 * the rest of the editor surface expects.
 *
 * The panel is intentionally pure rendering + bridge calls — it does
 * not touch the editor's content, never edits source. The host tab
 * (agent_tab / market_tab) owns the editor; this panel just observes.
 */

import { esc } from './_util.js';

const RESCAN_DEBOUNCE_MS = 300;


export function mountLiveSignaturePanel(host, opts = {}) {
    if (!host) return _noopController();
    const {
        kind, id, editor, vantage = 'outbound',
        getSource,
        logger = { warn(){}, debug(){} },
    } = opts;
    if (!kind || !id) {
        host.innerHTML = '';
        return _noopController();
    }

    host.classList.add('ea-live-sig');
    host.innerHTML = `<div class="ea-live-sig__loading">Loading signature…</div>`;

    let declared = null;        // { framework, inbound, required_methods, required_attributes }
    let scanned  = null;        // { scanned, declared, diff, origin }
    let rescanTimer = null;
    let editorListener = null;
    let destroyed = false;
    // Persist the collapse state across re-renders (per-keystroke
    // rescans recreate the DOM; without this the panel re-opens on
    // every edit). Defaults to open on first paint.
    let isOpen = true;

    const rerender = () => {
        if (destroyed) return;
        if (declared == null && scanned == null) {
            host.innerHTML =
                `<div class="ea-live-sig__loading">Loading signature…</div>`;
            return;
        }
        host.innerHTML = _renderPanel(
            { declared, scanned, vantage, isOpen });
        // Track the user's open/closed choice across the next rescan.
        const detailsEl = host.querySelector('.ea-live-sig__details');
        detailsEl?.addEventListener('toggle', () => {
            isOpen = !!detailsEl.open;
        });
        // Wire Implement buttons. Each one stamps a stub for that
        // method's signature into the editor and triggers a rescan so
        // the row flips from "missing" to "match" without a round trip.
        for (const btn of host.querySelectorAll('[data-action="implement"]')) {
            btn.addEventListener('click', () => {
                const sig  = btn.getAttribute('data-signature') || '';
                const note = btn.getAttribute('data-note') || '';
                _insertMethodStub(editor, sig, note);
                btn.disabled = true;
                btn.title = 'Stub inserted';
            });
        }
        // "Apply signature" — for override rows. The method body already
        // exists; we only rewrite its `def …:` header line so the
        // parameter list matches the contract again. Re-scan will flip
        // the row from `override` to `match`.
        for (const btn of host.querySelectorAll('[data-action="apply-signature"]')) {
            btn.addEventListener('click', () => {
                const name = btn.getAttribute('data-method') || '';
                const sig  = btn.getAttribute('data-signature') || '';
                if (!_applySignature(editor, name, sig)) {
                    btn.title = 'Could not locate the method header';
                    return;
                }
                btn.disabled = true;
                btn.title = 'Signature applied';
            });
        }
    };

    // --- initial fetch -------------------------------------------------

    const api = window.pywebview?.api;

    Promise.resolve(api?.entity_signature?.(kind, id))
        .then((res) => { declared = res || {}; rerender(); })
        .catch((err) => {
            logger.warn?.('live signature: entity_signature failed', { err });
            declared = {};
            rerender();
        });

    const rescan = (source) => {
        return Promise.resolve(
            api?.entity_scan_methods?.(kind, id, source),
        ).then((res) => {
            if (destroyed) return;
            scanned = res || {};
            rerender();
        }).catch((err) => {
            logger.warn?.('live signature: scan failed', { err });
            scanned = {};
            rerender();
        });
    };

    // First scan uses the on-disk source.
    rescan(undefined);

    // --- editor change wiring -----------------------------------------

    if (editor && typeof editor.onDidChangeModelContent === 'function') {
        editorListener = editor.onDidChangeModelContent(() => {
            if (rescanTimer) clearTimeout(rescanTimer);
            rescanTimer = setTimeout(() => {
                rescanTimer = null;
                const src = (typeof getSource === 'function')
                    ? getSource()
                    : editor.getValue();
                rescan(src);
            }, RESCAN_DEBOUNCE_MS);
        });
    }

    return {
        destroy: () => {
            destroyed = true;
            if (rescanTimer) clearTimeout(rescanTimer);
            try { editorListener?.dispose?.(); } catch { /* ignore */ }
            host.innerHTML = '';
            host.classList.remove('ea-live-sig');
        },
        /** Force an immediate re-scan against the supplied source. The
         *  agent_tab uses this when the editor isn't a Monaco instance
         *  (fallback path) and needs to nudge the panel manually. */
        rescan,
    };
}


function _renderPanel({ declared, scanned, vantage, isOpen = true }) {
    const diff      = scanned?.diff || {};
    const framework = declared?.framework || [];
    const matched   = diff.match    || [];
    const overrides = diff.override || [];
    const missing   = diff.missing  || [];
    const extra     = diff.extra    || [];
    const scanOk    = !!scanned?.ok;
    // When scanOk is false (scan path unavailable for this kind),
    // synthesise rows from the framework list with status='declared'
    // so the user still sees the contract.
    const scannedByName = new Set();
    for (const list of [matched, overrides, missing, extra]) {
        for (const m of list) if (m?.name) scannedByName.add(m.name);
    }
    const declaredOnly = scanOk ? [] : framework.filter(
        (f) => f?.name && !scannedByName.has(f.name));
    // Framework metadata keyed by method name → description / required.
    const meta = {};
    for (const f of framework) {
        if (!f?.name) continue;
        meta[f.name] = {
            description: f.description || '',
            required:    !!f.required,
            signature:   f.signature   || '',
        };
    }
    // Header summary verdict — green / amber / red. Required-missing
    // is red; non-required missing or any drift is amber; otherwise OK.
    const requiredMissing = missing.filter(
        (m) => meta[m.name]?.required !== false).length;
    const verdict = !scanOk
        ? { label: 'declared contract',
            cls:   'ea-live-sig__verdict--warn' }
        : requiredMissing
            ? { label: 'missing required',
                cls:   'ea-live-sig__verdict--err' }
            : (overrides.length || missing.length)
                ? { label: 'signature drift',
                    cls:   'ea-live-sig__verdict--warn' }
                : { label: 'contract met',
                    cls:   'ea-live-sig__verdict--ok' };
    // Build one unified row list, then sort: required-first, then by
    // bucket priority (missing → override → match → extra → declared).
    const BUCKET_RANK = {
        missing: 0, override: 1, match: 2, declared: 3, extra: 4,
    };
    const allRows = [
        ...missing.map((m)   => ({ m, bucket: 'missing'  })),
        ...overrides.map((m) => ({ m, bucket: 'override' })),
        ...matched.map((m)   => ({ m, bucket: 'match'    })),
        ...extra.map((m)     => ({ m, bucket: 'extra'    })),
        ...declaredOnly.map((f) => ({
            m: { name: f.name,
                 signature: f.signature || `${f.name}(self, ...)` },
            bucket: 'declared',
        })),
    ];
    allRows.sort((a, b) => {
        const ar = meta[a.m.name]?.required ? 0 : 1;
        const br = meta[b.m.name]?.required ? 0 : 1;
        if (ar !== br) return ar - br;
        const ab = BUCKET_RANK[a.bucket] ?? 9;
        const bb = BUCKET_RANK[b.bucket] ?? 9;
        if (ab !== bb) return ab - bb;
        return String(a.m.name || '').localeCompare(String(b.m.name || ''));
    });
    const rows = allRows.map(({ m, bucket }) => _row(m, bucket, meta)).join('');
    const totalReq = matched.length + missing.length + overrides.length;
    const body = rows
        ? `<table class="ea-table ea-live-sig__table">
               <thead><tr>
                   <th class="ea-live-sig__col-req">Required</th>
                   <th class="ea-live-sig__col-method">Method</th>
                   <th class="ea-live-sig__col-status">Status</th>
                   <th class="ea-live-sig__col-note">Description / note</th>
                   <th class="ea-live-sig__col-action"></th>
               </tr></thead>
               <tbody>${rows}</tbody>
           </table>`
        : `<div class="ea-live-sig__empty">${_renderEmptyHint(vantage)}</div>`;
    const counts = scanOk
        ? `${matched.length}/${totalReq} matched`
            + (extra.length ? ` · ${extra.length} extra` : '')
        : `${framework.length} declared`;
    // Wrap in `<details>` so the panel collapses to its title strip,
    // freeing space for the Monaco editor below. The caller-supplied
    // `isOpen` flag persists the user's choice across re-renders
    // (each editor keystroke rebuilds the DOM via `rerender`).
    return `
        <details class="ea-live-sig__details"${isOpen ? ' open' : ''}>
            <summary class="ea-live-sig__head">
                <span class="ea-live-sig__title">Signature</span>
                <span class="ea-live-sig__verdict ${verdict.cls}">
                    ${esc(verdict.label)}
                </span>
                <span class="ea-live-sig__counts">${counts}</span>
            </summary>
            ${body}
        </details>
    `;
}


const _STATUS_LABEL = {
    match:    'satisfies',
    override: 'signature differs',
    missing:  'missing',
    extra:    'extra',
    declared: 'declared',
};


function _row(m, bucket, meta) {
    const sig    = m.signature || m.name || '';
    const name   = m.name || '';
    const frame  = meta[name] || {};
    const note   = m.diagnostic || frame.description || '';
    const req    = !!frame.required;
    const status = _STATUS_LABEL[bucket] || bucket;
    // "Implement" — for methods that don't yet exist in the user's
    // source (`missing` from a real diff, `declared` synthesised when
    // the scan path is unavailable). "Apply" — for `override` rows
    // where the method exists but its signature drifted; clicking
    // rewrites just the `def …:` header to match the contract.
    const canImplement = bucket === 'missing' || bucket === 'declared';
    const canApply     = bucket === 'override' && !!frame.signature;
    const stubSig = sig || `${name}(self)`;
    const contractSig = frame.signature || stubSig;
    let action = '';
    if (canImplement) {
        action = `<button type="button" class="ea-btn ea-btn--small"
                   data-action="implement"
                   data-signature="${esc(stubSig)}"
                   data-note="${esc(frame.description || '')}"
                   title="Insert a stub for ${esc(name)} at the end of the class">
               <span class="material-symbols-outlined">add</span>
               Implement
           </button>`;
    } else if (canApply) {
        action = `<button type="button" class="ea-btn ea-btn--small"
                   data-action="apply-signature"
                   data-method="${esc(name)}"
                   data-signature="${esc(contractSig)}"
                   title="Rewrite the def-${esc(name)} header to match the AgentBase / MarketBase / AssetBase contract">
               <span class="material-symbols-outlined">sync</span>
               Apply signature
           </button>`;
    }
    return `
        <tr class="ea-live-sig__row ea-live-sig__row--${esc(bucket)}${
                req ? ' ea-live-sig__row--required' : ''}"
            data-line="${m.source_line || 0}">
            <td class="ea-live-sig__col-req">${
                req
                    ? '<span class="ea-chip ea-chip--required" title="Required by the base class — engine relies on it">required</span>'
                    : '<span class="ea-live-sig__optional" title="Optional — a no-op default is supplied by the base class">optional</span>'
            }</td>
            <td class="ea-live-sig__col-method"><code>${esc(sig)}</code></td>
            <td class="ea-live-sig__col-status">
                <span class="ea-live-sig__status ea-live-sig__status--${esc(bucket)}">
                    ${esc(status)}
                </span>
            </td>
            <td class="ea-live-sig__col-note">${esc(note)}</td>
            <td class="ea-live-sig__col-action">${action}</td>
        </tr>`;
}


/** Append a `def <signature>:` stub to the end of the editor's class.
 *  Scans the source for the most-common method indentation level and
 *  uses it; defaults to 4 spaces. Inserts after the last `def ` line so
 *  the new method joins the class body rather than dangling at module
 *  scope. */
function _insertMethodStub(editor, signature, description) {
    if (!editor) return;
    const model = editor.getModel?.();
    if (!model) return;
    const source = model.getValue();
    const lines = source.split('\n');
    // Find the indentation of existing `def ` lines inside a class. If
    // none exists, fall back to 4 spaces.
    let indent = '    ';
    for (const line of lines) {
        const m = line.match(/^(\s+)def\s+\w/);
        if (m) { indent = m[1]; break; }
    }
    // Find the last `def `-headed block to know where to splice in.
    let insertAfter = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (/^\s+def\s+\w/.test(lines[i])) { insertAfter = i + 1; break; }
    }
    // Skip past the method body that belongs to the last `def`.
    while (insertAfter < lines.length) {
        const next = lines[insertAfter];
        // Stop when we hit a line that's clearly outside the method
        // (blank lines are part of the body; dedented code lines end it).
        if (next.trim() === '') { insertAfter++; continue; }
        const leading = next.match(/^(\s*)/)[1];
        if (leading.length <= indent.length
            && !next.startsWith(indent + ' ')) break;
        insertAfter++;
    }
    const docLine = description
        ? `\n${indent}    """${description.replace(/"""/g, "'''")}"""`
        : '';
    const stub =
        `\n${indent}def ${signature}:`
        + docLine
        + `\n${indent}    pass\n`;
    editor.executeEdits('live-sig-implement', [{
        range: {
            startLineNumber: insertAfter + 1, startColumn: 1,
            endLineNumber:   insertAfter + 1, endColumn:   1,
        },
        text: stub,
        forceMoveMarkers: true,
    }]);
    // Place the cursor inside the new method so the user can start
    // typing the body.
    const cursorLine = insertAfter + (docLine ? 3 : 2);
    editor.setPosition?.({
        lineNumber: cursorLine,
        column:     indent.length + 5,
    });
    editor.focus?.();
}


/** Rewrite the existing `def <name>(...):` header in the editor to
 *  match `contractSig` (the canonical signature from AgentBase /
 *  MarketBase / AssetBase). Preserves the line's leading whitespace,
 *  leaves the body untouched, returns true on success. */
function _applySignature(editor, methodName, contractSig) {
    if (!editor || !methodName || !contractSig) return false;
    const model = editor.getModel?.();
    if (!model) return false;
    const lineCount = model.getLineCount?.() || 0;
    // Match `def <name>` allowing for any whitespace before, then any
    // signature content up to the trailing `:`. Multi-line signatures
    // (very rare in practice — our gallery wraps onto one line) aren't
    // handled here; fall back to false so the caller can flag it.
    const headerRe = new RegExp(
        '^(\\s*)def\\s+' + methodName.replace(
            /[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b[^:]*:\\s*$',
    );
    for (let ln = 1; ln <= lineCount; ln++) {
        const text = model.getLineContent?.(ln) ?? '';
        const m = text.match(headerRe);
        if (!m) continue;
        const indent = m[1] || '';
        const replacement = `${indent}def ${contractSig}:`;
        editor.executeEdits('live-sig-apply', [{
            range: {
                startLineNumber: ln, startColumn: 1,
                endLineNumber:   ln, endColumn:   text.length + 1,
            },
            text: replacement,
            forceMoveMarkers: true,
        }]);
        return true;
    }
    return false;
}


function _renderDeclaredSummary({ declared, vantage }) {
    const framework = declared?.framework || [];
    const inbound   = declared?.inbound   || [];
    if (vantage === 'inbound') {
        // Vantage 'inbound' = "what others require of this code".
        const items = framework.map((m) => `
            <li>
                <code>${esc(m.name || '')}</code>
                ${m.required ? '<span class="ea-chip ea-chip--required">required</span>' : ''}
                ${m.description ? `<span class="ea-live-sig__desc">${esc(m.description)}</span>` : ''}
            </li>
        `).join('');
        if (!framework.length && !inbound.length) return '';
        return `
            <details class="ea-live-sig__declared">
                <summary>Declared contract (${framework.length + inbound.length})</summary>
                <ul>${items}</ul>
                ${inbound.length ? `<p class="ea-live-sig__desc">
                    Plus ${inbound.length} inbound dependency
                    ${inbound.length === 1 ? '' : 's'} from other entities.
                </p>` : ''}
            </details>`;
    }
    // Outbound vantage: surface what THIS code is allowed to call on
    // others — currently a place-holder until we ship the per-entity
    // relationship resolver in Phase 4.
    return '';
}


function _renderEmptyHint(vantage) {
    return `<span class="ea-live-sig__empty">No methods detected${
        vantage === 'inbound'
            ? ' and no inbound contract declared.'
            : '.'
    }</span>`;
}


function _noopController() {
    return { destroy() {}, rescan() {} };
}
