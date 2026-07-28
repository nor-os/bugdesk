/**
 * GodleyMatrixEditor — the editable Godley matrix for an agent.
 *
 * Hybrid of EcoSim's table UX and EcoAgent's richer columns, built on the
 * shared `GodleyTable` renderer (so the read-only preview, the roll-up and
 * this editor all share one matrix + one stylesheet). This module is the
 * EDITOR shell: it owns the raw leg-level flows (the `serialize_rows` shape
 * the bridge round-trips), adapts them to the cell-shaped rows `GodleyTable`
 * renders, and maps every edit back onto the legs.
 *
 *   • Cells   — the signed amount expression of the agent's self-postings;
 *               editable inline via Monaco (Python + agent autocomplete),
 *               double-click pops out a larger editor.
 *   • Counterparty — the cross-agent legs (other agent · amount), rendered
 *               in the leg-model meta column (override of GodleyTable's
 *               cell-model axis/role chips).
 *   • Trigger — the flow's flat trigger (every_tick / when / for_each),
 *               editable via a small form.
 *   • Accounts — add / rename / delete via the header affordances.
 *   • Initial conditions — editable numeric row.
 *
 * The balance column runs the per-flow SFC check (A − L − E = 0 over the
 * own legs; cross-agent rows close with the counterparty — see the TFM).
 *
 *   new GodleyMatrixEditor({ accounts, flows, kinds, initial_conditions,
 *                            completionCtx, readonly, onSave,
 *                            onAccountsChange }).mount(host)
 */

import { GodleyTable, esc } from './godley_table.js';

const TYPES = ['Assets', 'Liabilities', 'Equity'];

/** Strip a leading `-` / `-(...)` wrapper → {neg, mag}. */
function _splitSign(expr) {
    const s = String(expr ?? '').trim();
    if (s.startsWith('-(') && s.endsWith(')')) return { neg: true, mag: s.slice(2, -1) };
    if (s.startsWith('-')) return { neg: true, mag: s.slice(1).trim() };
    return { neg: false, mag: s };
}

/** Dr/Cr for a stored (signed) leg amount on an account of `type`. A
 *  balance-INCREASE (+expr) is Dr on an Asset, Cr on L/E. */
function _dirOf(expr, type) {
    const { neg } = _splitSign(expr);
    const increase = !neg;
    return (increase === (type === 'Assets')) ? 'dr' : 'cr';
}

/** Sign a magnitude for a leg given Dr/Cr + account type: a balance INCREASE
 *  is +mag, a DECREASE is -(mag). Dr Asset / Cr L|E increase. */
function _signed(dir, mag, type) {
    if (!mag) return '';
    const increase = (dir === 'dr' && type === 'Assets')
        || (dir === 'cr' && type !== 'Assets');
    return increase ? mag : `-(${mag})`;
}

/** Arithmetic-eval a signed expression with every free variable → 1.
 *  Returns NaN when it isn't safely numeric (the caller abstains). */
function _evalAtOne(expr) {
    const s = String(expr ?? '').trim();
    if (!s) return 0;
    if (!/^[\s+\-*/().\d,\w]+$/.test(s)) return NaN;
    try {
        // eslint-disable-next-line no-new-func
        const v = Function(`"use strict"; return (${s.replace(/[a-zA-Z_]\w*/g, '1')});`)();
        return Number.isFinite(v) ? v : NaN;
    } catch { return NaN; }
}


export class GodleyMatrixEditor {
    constructor({
        accounts = {}, flows = [], kinds = [], initial_conditions = {},
        completionCtx = {}, readonly = false, onSave = null,
        onAccountsChange = null,
    } = {}) {
        this._accounts = TYPES.reduce((o, t) => {
            o[t] = Array.isArray(accounts?.[t]) ? accounts[t] : [];
            return o;
        }, {});
        this._rebuildAccountIndex();
        this._initial = initial_conditions || {};
        this._nextUid = 0;
        this._flows = (Array.isArray(flows) ? flows : [])
            .map((f) => ({ ...f, _uid: this._nextUid++ }));
        this._kinds = kinds;
        this._completionCtx = completionCtx || {};
        this._readonly = !!readonly;
        this._onSave = onSave;
        this._onAccountsChange = onAccountsChange;
        this._dirty = false;
        this._host = null;
        this._tableHost = null;
        this._monaco = null;       // cached factory.monaco (for KeyCode)
        // Account columns the user added a column for this session but which
        // have no expression yet (so they survive a re-render until used).
        this._addedAccounts = new Set();
    }

    _rebuildAccountIndex() {
        this._cols = TYPES.flatMap((t) => this._accounts[t].map((a) => ({ ...a, type: t })));
        this._labelToType = {};
        this._labelToAcct = {};
        this._kindToLabel = {};
        for (const c of this._cols) {
            this._labelToType[c.label] = c.type;
            this._labelToAcct[c.label] = c;
            if (c.asset_kind && !(c.asset_kind in this._kindToLabel)) {
                this._kindToLabel[c.asset_kind] = c.label;
            }
        }
    }

    mount(host) {
        this._host = host;
        host.innerHTML = '';
        host.classList.add('ea-gme-host');
        this._tableHost = document.createElement('div');
        host.appendChild(this._tableHost);
        if (!this._readonly) host.appendChild(this._foot());
        this._renderTable();
    }

    _flowByUid(uid) {
        return this._flows.find((f) => f._uid === uid) || null;
    }

    // ── leg ↔ view adapter ───────────────────────────────────────────────

    /** Resolve a flow's editable own-account cells + counterparty legs. */
    _shape(flow) {
        const cells = {};       // label -> {dir, mag, leg, signed}
        const cps = [];         // {party, kind, amount, account, legRef}
        let editable = flow.type === 'Row';
        if (flow.type === 'Row') {
            for (const leg of (flow.legs || [])) {
                if (leg.party === 'self') {
                    const label = leg.account || this._kindToLabel[leg.kind];
                    if (label && label in this._labelToType) {
                        const t = this._labelToType[label];
                        cells[label] = { ..._splitSign(leg.amount), dir: _dirOf(leg.amount, t), leg, signed: leg.amount };
                    }
                } else {
                    cps.push({ party: leg.party, kind: leg.kind, amount: leg.amount, account: leg.account, account_type: leg.account_type || '', legRef: leg });
                }
            }
        } else if (flow.type === 'Pay') {
            cps.push({ party: flow.payee, kind: 'deposits', amount: flow.amount });
            editable = false;
        } else { // Produce / Consume — editable inline (amount; Dr/Cr flips type)
            editable = true;
            const label = this._kindToLabel[flow.kind];
            if (label) cells[label] = { mag: flow.amount, dir: flow.type === 'Consume' ? 'cr' : 'dr', leg: null, signed: flow.type === 'Consume' ? `-(${flow.amount})` : flow.amount };
        }
        return { cells, cps, editable };
    }

    _flowName(flow) {
        if (flow.type === 'Pay') return `pay → ${(flow.payee || '').replace(/^=/, '')}`;
        if (flow.type === 'Produce') return `produce ${flow.kind}`;
        if (flow.type === 'Consume') return `consume ${flow.kind}`;
        const sh = this._shape(flow);
        const own = Object.keys(sh.cells);
        return own.length ? own.join(' / ') : 'flow';
    }

    /** Adapt leg flows → cell-shaped GodleyTable rows. */
    _toRows() {
        return this._flows.map((flow) => {
            const sh = this._shape(flow);
            const cells = {};
            for (const [label, c] of Object.entries(sh.cells)) cells[label] = c.signed;
            return {
                _uid:        flow._uid,
                // Flow name is PURE FREE TEXT — no derivation from legs/type/
                // sign (so flipping +/- never renames). Empty → a neutral
                // placeholder rendered by GodleyTable.
                template:    '',
                label:       flow.label || '',
                role:        'self',
                editable:    sh.editable,
                cells,
                overrides:   [],
                counterparties: {},
                trigger:     null,
                cross_agent: sh.cps.length > 0,
                balance:     this._legBalance(flow, sh),
            };
        });
    }

    /** Per-flow SFC verdict over OWN + COUNTERPARTY legs:
     *    ΣAssetsΔ − ΣLiabilitiesΔ − ΣEquityΔ ≈ 0 (every free var → 1).
     *  Own legs are typed from the agent's chart; counterparty legs from the
     *  AUTHORED `account_type` on the leg. Returns:
     *    true   — balances (greens)
     *    false  — unbalanced (reds)
     *    null   — non-numeric, can't verify (abstain, '?')
     *    'cross-agent' — a counterparty leg has no authored type, so the
     *                    counter-posting can't be classified ('↔', honest). */
    _legBalance(flow, sh) {
        if (flow.type !== 'Row') {
            // Produce/Consume are equity-balanced (mining); Pay is cross.
            if (flow.type === 'Pay') return 'cross-agent';
            return true;   // Produce/Consume: residual absorbed by equity
        }
        // Authored "balanced by equity" — the residual hits equity (mining /
        // produce / revaluation), so it balances by construction.
        if (flow.equity_balanced) return true;
        // An empty flow (no postings, no counterparty) isn't "balanced" — it's
        // incomplete; don't green it.
        if (Object.keys(sh.cells).length === 0 && sh.cps.length === 0) return null;
        let a = 0, l = 0, e = 0, abstain = false, untyped = false;
        const add = (type, signed) => {
            const v = _evalAtOne(signed);
            if (Number.isNaN(v)) { abstain = true; return; }
            if (type === 'Assets') a += v;
            else if (type === 'Liabilities') l += v;
            else if (type === 'Equity') e += v;
            else { untyped = true; }
        };
        for (const [label, c] of Object.entries(sh.cells)) {
            add(this._labelToType[label], c.signed);
        }
        for (const cp of sh.cps) {
            if (!cp.account_type) { untyped = true; continue; }
            add(cp.account_type, cp.amount);
        }
        if (untyped) return 'cross-agent';   // an unclassifiable counter-leg
        if (abstain) return null;
        return Math.abs(a - l - e) < 1e-9;
    }

    _renderTable() {
        this._table = new GodleyTable({
            accounts: this._displayAccounts(),
            accountTypes: ['Assets', 'Liabilities'],   // Equity is automatic
            rows: this._toRows(),
            initial_conditions: this._initial,
            readonly: false,
            showInitial: true,
            showDrCr: true,
            onDirFlip:         (idx, label, row) => this._onDirFlip(row._uid, label),
            onCellEdit:        (idx, label, next, row) => this._onCellEdit(row._uid, label, next),
            onDeleteRow:       (idx, row) => this._onDeleteRow(row._uid),
            onLabelEdit:       (idx, name, row) => this._onLabelEdit(row._uid, name),
            onAddRow:          () => this._onAddRow(),
            onAccountAdd:      (type) => this._onAccountAdd(type),
            onAccountRename:   (type, oldL, newL) => this._onAccountRename(type, oldL, newL),
            onAccountDelete:   (type, label) => this._onAccountDelete(type, label),
            onInitialEdit:     (label, value) => this._onInitialEdit(label, value),
            editorAdapter:     this._makeEditorAdapter(),
            renderCounterpartyCell: (row) => this._counterpartyCell(row._uid),
            renderTriggerCell:      (row) => this._triggerCell(row._uid),
            emptyHint: 'No flow rows yet — use “+ Add row”, then click a cell to enter a signed amount expression.',
        });
        this._table.mount(this._tableHost);
    }

    // ── cell editing (leg-level) ─────────────────────────────────────────

    // `next` is the MAGNITUDE (Dr/Cr mode); re-sign by the cell's current
    // direction, defaulting a new cell to its natural increase (Dr asset /
    // Cr liability).
    _onCellEdit(uid, label, next) {
        const flow = this._flowByUid(uid);
        if (!flow) return;
        const mag0 = String(next ?? '').trim();
        if (flow.type === 'Produce' || flow.type === 'Consume') {
            flow.amount = mag0;          // the magnitude is the produced/consumed quantity
            this._touch(); this._renderTable(); return;
        }
        if (flow.type !== 'Row') return;
        const mag = mag0;
        const type = this._labelToType[label];
        const acct = this._labelToAcct[label];
        let leg = (flow.legs || []).find((l) => l.party === 'self'
            && (l.account === label || (!l.account && this._kindToLabel[l.kind] === label)));
        if (mag === '') {
            if (leg) flow.legs = flow.legs.filter((l) => l !== leg);
        } else {
            const dir = leg ? _dirOf(leg.amount, type) : (type === 'Assets' ? 'dr' : 'cr');
            const signed = _signed(dir, mag, type);
            if (leg) leg.amount = signed;
            else flow.legs = [...(flow.legs || []),
                { party: 'self', kind: acct?.asset_kind || label, amount: signed, account: label }];
        }
        this._touch();
        this._renderTable();
    }

    /** Flip a self cell's Dr/Cr direction (re-signs the stored amount). For a
     *  produce/consume flow, Dr↔Cr converts between producing and consuming. */
    _onDirFlip(uid, label) {
        const flow = this._flowByUid(uid);
        if (!flow) return;
        if (flow.type === 'Produce') { flow.type = 'Consume'; this._touch(); this._renderTable(); return; }
        if (flow.type === 'Consume') { flow.type = 'Produce'; this._touch(); this._renderTable(); return; }
        if (flow.type !== 'Row') return;
        const type = this._labelToType[label];
        const leg = (flow.legs || []).find((l) => l.party === 'self'
            && (l.account === label || (!l.account && this._kindToLabel[l.kind] === label)));
        if (!leg) return;
        const mag = _splitSign(leg.amount).mag;
        const newDir = _dirOf(leg.amount, type) === 'dr' ? 'cr' : 'dr';
        leg.amount = _signed(newDir, mag, type);
        this._touch();
        this._renderTable();
    }

    /** Accounts to render: those used by some flow (or added this session),
     *  excluding Equity (which is automatic). */
    _displayAccounts() {
        const used = new Set(this._addedAccounts);
        for (const flow of this._flows) {
            const sh = this._shape(flow);
            for (const label of Object.keys(sh.cells)) {
                if (this._labelToType[label] !== 'Equity') used.add(label);
            }
        }
        const out = { Assets: [], Liabilities: [] };
        for (const t of ['Assets', 'Liabilities']) {
            out[t] = this._accounts[t].filter((a) => used.has(a.label));
        }
        return out;
    }

    _onAddRow() {
        this._flows.push({ type: 'Row', legs: [], trigger: { kind: 'every_tick' }, _uid: this._nextUid++ });
        this._touch();
        this._renderTable();
    }

    /** Rename a flow — pure free text, stored verbatim (no semantics). */
    _onLabelEdit(uid, name) {
        const flow = this._flowByUid(uid);
        if (!flow) return;
        flow.label = String(name ?? '').trim();
        this._touch();
        this._renderTable();
    }

    _onDeleteRow(uid) {
        this._flows = this._flows.filter((f) => f._uid !== uid);
        this._touch();
        this._renderTable();
    }

    // ── counterparty + trigger meta cells (leg model) ────────────────────

    _counterpartyCell(uid) {
        const flow = this._flowByUid(uid);
        const td = document.createElement('td');
        td.className = 'ea-godley__cell ea-godley__cell--meta ea-godley__cell--cp';
        if (!flow) return td;
        // Produce/Consume book against equity (mining) — show it.
        if (flow.type === 'Produce' || flow.type === 'Consume') {
            const eq = document.createElement('span');
            eq.className = 'ea-chip ea-chip--equity ea-chip--on';
            eq.textContent = '≡ Equity';
            eq.title = 'Balanced by equity — produce/consume books against equity (mining).';
            td.appendChild(eq);
            return td;
        }
        const sh = this._shape(flow);
        sh.cps.forEach((cp) => {
            const party = (cp.party || '').replace(/^=/, '');
            const typed = !!cp.account_type;
            const neg = _splitSign(cp.amount).neg;
            const chip = document.createElement('span');
            chip.className = 'ea-chip ea-chip--leg-cp ea-chip--clickable';
            chip.innerHTML =
                `<span class="ea-chip__role">${esc(_shortParty(party))}</span>`
                + (cp.account ? `<span class="ea-chip__axis">${esc(cp.account)}</span>` : '')
                + `<span class="ea-chip__delta ea-chip__delta--${neg ? 'neg' : 'pos'}">${neg ? '−' : '+'}</span>`
                + `<span class="ea-chip__detail">${esc(_splitSign(cp.amount).mag)}</span>`
                + ((typed || flow.type === 'Pay') ? '' : '<span class="ea-chip__warn" title="No account type — not balance-checkable">?</span>');
            chip.title = 'Click to edit the counterparty';
            const open = () => this._editCounterparty(uid, cp.legRef || null);
            chip.addEventListener('click', open);
            if (flow.type === 'Row' && cp.legRef) {
                chip.appendChild(this._chipActions([
                    ['edit', 'Edit counterparty', open],
                    ['close', 'Remove counterparty', () => this._removeCounterparty(uid, cp.legRef), true],
                ]));
            }
            td.appendChild(chip);
        });
        // Row with no counterparty: equity toggle + add (mutually exclusive).
        if (flow.type === 'Row' && sh.cps.length === 0) {
            const eq = document.createElement('button');
            eq.type = 'button';
            eq.className = 'ea-chip ea-chip--equity' + (flow.equity_balanced ? ' ea-chip--on' : '');
            eq.textContent = flow.equity_balanced ? '≡ Equity ✓' : '≡ Equity';
            eq.title = flow.equity_balanced
                ? 'Balanced by equity — click to turn off'
                : 'Balance this flow by equity (mining / produce / revaluation)';
            eq.addEventListener('click', () => {
                flow.equity_balanced = !flow.equity_balanced;
                this._touch(); this._renderTable();
            });
            td.appendChild(eq);
            if (!flow.equity_balanced) {
                const add = document.createElement('button');
                add.type = 'button';
                add.className = 'ea-chip ea-chip--add';
                add.textContent = '+ counterparty';
                add.title = 'Add the counterparty (the other side of this flow)';
                add.addEventListener('click', () => this._editCounterparty(uid, null));
                td.appendChild(add);
            }
        }
        return td;
    }

    _triggerCell(uid) {
        const flow = this._flowByUid(uid);
        const td = document.createElement('td');
        td.className = 'ea-godley__cell ea-godley__cell--meta ea-godley__cell--trigger';
        if (!flow) return td;
        const t = flow.trigger || { kind: 'every_tick' };
        const detail = t.kind === 'when' ? (t.expr || '') : t.kind === 'for_each' ? (t.iterable || '') : '';
        const chip = document.createElement('span');
        chip.className = 'ea-chip ea-chip--trigger ea-chip--clickable';
        chip.innerHTML =
            `<span class="ea-chip__kind">${esc(_trigLabel(t.kind))}</span>`
            + (detail ? `<span class="ea-chip__detail">${esc(detail)}</span>` : '');
        chip.title = 'Click to edit the trigger';
        chip.addEventListener('click', () => this._editTrigger(uid));
        chip.appendChild(this._chipActions([['edit', 'Edit trigger', () => this._editTrigger(uid)]]));
        td.appendChild(chip);
        return td;
    }

    /** Hover-revealed chip actions. `specs` = [[icon, title, onClick, isDel?]]. */
    _chipActions(specs) {
        const actions = document.createElement('span');
        actions.className = 'ea-godley__chip-actions';
        for (const [icon, title, onClick, isDel] of specs) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ea-godley__chip-btn' + (isDel ? ' ea-godley__chip-btn--del' : '');
            btn.title = title;
            btn.innerHTML = `<span class="material-symbols-outlined">${icon}</span>`;
            btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
            actions.appendChild(btn);
        }
        return actions;
    }

    /** Trigger editor (modal). */
    async _editTrigger(uid) {
        const flow = this._flowByUid(uid);
        if (!flow) return;
        const t = flow.trigger || { kind: 'every_tick' };
        const { openForm } = await import('./modal.js');
        const data = await openForm({
            title: 'Edit trigger',
            fields: [
                { name: 'kind', label: 'Fires', type: 'select',
                  options: [
                      { value: 'every_tick', label: 'Every tick' },
                      { value: 'when', label: 'When (condition)' },
                      { value: 'for_each', label: 'For each (iterable)' },
                  ] },
                { name: 'expr', label: 'Condition (when)', type: 'text', placeholder: 'self.balance > 0' },
                { name: 'iterable', label: 'Iterable (for_each)', type: 'text', placeholder: "ctx.agents.archetype('worker')" },
            ],
            defaults: { kind: t.kind || 'every_tick', expr: t.expr || '', iterable: t.iterable || '' },
            submitLabel: 'Set trigger',
        });
        if (!data) return;
        const next = { kind: data.kind };
        if (data.kind === 'when' && data.expr) next.expr = data.expr;
        if (data.kind === 'for_each' && data.iterable) next.iterable = data.iterable;
        flow.trigger = next;
        this._touch();
        this._renderTable();
    }

    /** Counterparty editor (modal). The direction is a +/- delta (does it push
     *  the counterparty's balance up or down); the account type is captured
     *  separately so the flow can be A-L-E balance-checked. */
    async _editCounterparty(uid, legRef) {
        const flow = this._flowByUid(uid);
        if (!flow || flow.type !== 'Row') return;
        const { openForm } = await import('./modal.js');
        const cur = legRef || { party: '', kind: 'deposits', amount: '', account: '', account_type: '' };
        const curMag = _splitSign(cur.amount).mag;
        const curDelta = _splitSign(cur.amount).neg ? '-' : '+';
        const data = await openForm({
            title: legRef ? 'Edit counterparty' : 'Add counterparty',
            fields: [
                { name: 'party', label: 'Counterparty', type: 'text', required: true,
                  placeholder: "=ctx.agents.archetype('government')[0]",
                  hint: 'A Python expression resolving to the other agent.' },
                { name: 'account', label: 'Their account', type: 'text', placeholder: 'deposits' },
                { name: 'account_type', label: 'Their account type', type: 'select',
                  hint: 'Their classification — needed to balance-check the flow '
                      + '(deposits = Liability for a bank, Asset for a holder).',
                  options: [
                      { value: '', label: '— not set (flow stays unverified) —' },
                      { value: 'Assets', label: 'Asset (to them)' },
                      { value: 'Liabilities', label: 'Liability (to them)' },
                      { value: 'Equity', label: 'Equity (to them)' },
                  ] },
                { name: 'direction', label: 'Direction', type: 'select',
                  hint: 'Does this push their balance up (+) or down (−)?',
                  options: [
                      { value: '+', label: '+  (increases their balance)' },
                      { value: '-', label: '−  (decreases their balance)' },
                  ] },
                { name: 'amount', label: 'Amount (magnitude)', type: 'text', required: true,
                  placeholder: 'self._iorb' },
                ...(legRef ? [{ name: '_delete', label: 'Delete this counterparty', type: 'checkbox', default: false }] : []),
            ],
            defaults: {
                party: (cur.party || '').replace(/^=/, ''),
                account: cur.account || '',
                account_type: cur.account_type || '',
                direction: curDelta,
                amount: curMag || '',
            },
            submitLabel: legRef ? 'Save' : 'Add',
        });
        if (!data) return;
        if (data._delete && legRef) {
            flow.legs = (flow.legs || []).filter((l) => l !== legRef);
        } else {
            const party = data.party.startsWith('=') ? data.party : `=${data.party}`;
            const amt = data.direction === '-' ? `-(${data.amount})` : data.amount;
            if (legRef) {
                legRef.party = party; legRef.kind = data.account || 'deposits'; legRef.amount = amt;
                legRef.account = data.account; legRef.account_type = data.account_type;
            } else {
                flow.legs = [...(flow.legs || []),
                    { party, kind: data.account || 'deposits', amount: amt, account: data.account, account_type: data.account_type }];
            }
        }
        this._touch();
        this._renderTable();
    }

    /** Remove a counterparty leg directly (the chip's delete action). */
    _removeCounterparty(uid, legRef) {
        const flow = this._flowByUid(uid);
        if (!flow || flow.type !== 'Row') return;
        flow.legs = (flow.legs || []).filter((l) => l !== legRef);
        this._touch();
        this._renderTable();
    }

    // ── account CRUD ─────────────────────────────────────────────────────

    async _onAccountAdd(type) {
        const { openForm } = await import('./modal.js');
        // Autocomplete over the agent's existing accounts of this type that
        // aren't already shown — pick one to reveal its column, or type a new
        // name. (Don't recreate accounts that already exist.)
        const shown = new Set((this._displayAccounts()[type] || []).map((a) => a.label));
        const candidates = (this._accounts[type] || []).filter((a) => !shown.has(a.label));
        const data = await openForm({
            title: `Show / add ${({ Assets: 'an Asset', Liabilities: 'a Liability', Equity: 'an Equity' })[type] || type} account`,
            fields: [
                { name: 'label', label: 'Account', type: 'select',
                  options: candidates.map((a) => ({ value: a.label, label: a.label })),
                  create: { onCreate: async (v) => String(v).trim(), hint: 'new account' },
                  hint: 'Pick an existing account to show its column, or type a new name.' },
            ],
            defaults: { label: '' },
            submitLabel: 'Add column',
        });
        if (!data?.label) return;
        const label = String(data.label).trim();
        if (!this._labelToType[label]) {
            // Genuinely new → add it to the agent's chart.
            this._accounts[type] = [...this._accounts[type], { label, asset_kind: '' }];
            this._rebuildAccountIndex();
        }
        this._addedAccounts.add(label);    // keep its column even before it has an expression
        this._afterAccountsChange();
    }

    _onAccountRename(type, oldLabel, newLabel) {
        const list = this._accounts[type];
        const acct = list.find((a) => a.label === oldLabel);
        if (!acct || this._labelToType[newLabel]) { this._renderTable(); return; }
        acct.label = newLabel;
        // Re-point any legs that named the old account.
        for (const flow of this._flows) {
            for (const leg of (flow.legs || [])) {
                if (leg.party === 'self' && leg.account === oldLabel) leg.account = newLabel;
            }
        }
        if (oldLabel in this._initial) {
            this._initial[newLabel] = this._initial[oldLabel];
            delete this._initial[oldLabel];
        }
        this._afterAccountsChange();
    }

    async _onAccountDelete(type, label) {
        const { openConfirm } = await import('./modal.js');
        const ok = await openConfirm({
            title: 'Delete account',
            message: `Delete the <strong>${esc(label)}</strong> account? Legs posting to it will be dropped.`,
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        this._accounts[type] = this._accounts[type].filter((a) => a.label !== label);
        for (const flow of this._flows) {
            if (flow.legs) flow.legs = flow.legs.filter((l) => !(l.party === 'self' && l.account === label));
        }
        delete this._initial[label];
        this._afterAccountsChange();
    }

    _onInitialEdit(label, value) {
        this._initial = { ...this._initial, [label]: value };
        this._touch();
        // Re-render so the IC balance check updates.
        this._renderTable();
    }

    _afterAccountsChange() {
        this._rebuildAccountIndex();
        this._touch();
        this._renderTable();
        if (this._onAccountsChange) {
            try { this._onAccountsChange(this._accounts, this._initial); } catch { /* non-fatal */ }
        }
    }

    // ── Monaco cell editor adapter ───────────────────────────────────────

    _makeEditorAdapter() {
        return {
            mountInline: (td, ctx) => this._mountMonacoInline(td, ctx),
            openPopout:  (ctx) => this._openCellModal(ctx),
        };
    }

    async _attachCompletions(factory, model) {
        try {
            const comp = await import('../agent_completions.js');
            comp.registerAgentCompletions(factory.monaco);
            comp.attachAgentContext(model, this._completionCtx);
        } catch { /* autocomplete is best-effort */ }
    }

    async _mountMonacoInline(td, ctx) {
        const host = document.createElement('div');
        host.className = 'ea-godley__cell-monaco';
        td.innerHTML = '';
        td.appendChild(host);
        let factory, handle;
        try {
            const mod = await import('../../notebook/monaco_editor_factory.js');
            factory = await mod.getEditorFactory();
            this._monaco = factory.monaco;
            handle = factory.createInlineEditor(host, ctx.value, { language: 'python' });
        } catch {
            return this._plainInline(td, ctx);
        }
        const monaco = factory.monaco;
        await this._attachCompletions(factory, handle.editor.getModel());
        handle.editor.focus();
        let done = false;
        const finish = (fn, getVal) => {
            if (done) return; done = true;
            const val = getVal ? handle.getValue() : null;
            try { handle.dispose(); } catch { /* noop */ }
            fn(val);
        };
        handle.editor.onDidBlurEditorText(() => finish((v) => ctx.commit(v), true));
        handle.editor.onKeyDown((e) => {
            if (e.keyCode === monaco.KeyCode.Enter) { e.preventDefault(); e.stopPropagation(); finish((v) => ctx.commit(v), true); }
            else if (e.keyCode === monaco.KeyCode.Escape) { e.preventDefault(); finish(() => ctx.cancel(), false); }
        });
    }

    _plainInline(td, ctx) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ea-godley__cell-input';
        input.value = ctx.value || '';
        td.innerHTML = '';
        td.appendChild(input);
        input.focus(); input.select();
        let done = false;
        input.addEventListener('blur', () => { if (done) return; done = true; ctx.commit(input.value); });
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
            else if (ev.key === 'Escape') { done = true; ctx.cancel(); }
        });
    }

    async _openCellModal(ctx) {
        let mod, factory;
        try {
            mod = await import('./modal.js');
            const fmod = await import('../../notebook/monaco_editor_factory.js');
            factory = await fmod.getEditorFactory();
        } catch {
            return; // pop-out unavailable; inline editing still works
        }
        const content = document.createElement('div');
        content.style.cssText = 'height:240px; min-width:480px; border:1px solid var(--ea-border,#333);';
        let handle = null;
        const res = await mod.openModal({
            title: `Edit cell · ${ctx.label}`,
            icon: 'function',
            content,
            width: 600,
            actions: [
                { label: 'Cancel', value: null },
                { label: 'Save', value: 'save', primary: true },
            ],
            onMount: () => {
                handle = factory.createEditor(content, ctx.value, { language: 'python', noAutoHeight: true, minimap: false });
                this._attachCompletions(factory, handle.editor.getModel());
                handle.editor.focus();
            },
        });
        const val = handle ? handle.getValue() : ctx.value;
        if (handle) { try { handle.dispose(); } catch { /* noop */ } }
        if (res === 'save') ctx.commit(val); else ctx.cancel();
    }

    // ── save ─────────────────────────────────────────────────────────────

    _foot() {
        // Autosave — no Save button (the app's pattern, like the code editor).
        // A small status span gives unobtrusive feedback.
        const f = document.createElement('div');
        f.className = 'ea-gme__foot';
        this._status = document.createElement('span');
        this._status.className = 'ea-gme__status';
        f.appendChild(this._status);
        return f;
    }

    _touch() {
        this._dirty = true;
        if (this._status) { this._status.textContent = 'Editing…'; this._status.className = 'ea-gme__status'; }
        this._scheduleAutosave();
    }

    _scheduleAutosave() {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._autosave(), 600);
    }

    /** The leg flows in `serialize_rows` shape (sans the editor's _uid). */
    serialize() {
        return this._flows.map(({ _uid, ...f }) => f);
    }

    async _autosave() {
        if (!this._onSave || !this._dirty) return;
        if (this._status) { this._status.textContent = 'Saving…'; this._status.className = 'ea-gme__status'; }
        let res;
        try { res = await this._onSave(this.serialize()); }
        catch (e) { res = { ok: false, error: String(e?.message || e) }; }
        if (res && res.ok) {
            this._dirty = false;
            if (this._status) { this._status.textContent = 'Saved'; this._status.className = 'ea-gme__status ea-gme__status--ok'; }
        } else if (this._status) {
            this._status.textContent = res?.abort ? `Not saved — ${res.error || ''}` : (res?.error || 'Save failed');
            this._status.className = 'ea-gme__status ea-gme__status--err';
        }
    }
}


// ── helpers ──────────────────────────────────────────────────────────────

function _trigLabel(kind) {
    return ({ every_tick: 'Every tick', when: 'When', for_each: 'For each', manual: 'Manual' })[kind] || kind || 'Every tick';
}

/** Shorten a counterparty Python expression for the chip face. */
function _shortParty(expr) {
    const m = String(expr).match(/archetype\(['"]([^'"]+)['"]\)/);
    if (m) return m[1];
    return String(expr).length > 22 ? String(expr).slice(0, 21) + '…' : String(expr);
}

export { esc };
