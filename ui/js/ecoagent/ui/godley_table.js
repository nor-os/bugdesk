/**
 * GodleyTable — declarative Godley accounting matrix.
 *
 * Two modes from one component (Godley P4 — do not fork):
 *
 *   • READ-ONLY (the #142 default): rows = flows the agent fires, each
 *     cell the signed amount_expr from the matching self-posting. Used
 *     by the Sector roll-up and as a contract view.
 *
 *   • EDITABLE (`readonly: false`): rows = effective FlowRows for the
 *     agent in one lifecycle phase. Adds a Counterparty pill-chip column
 *     and a Trigger chip column, makes account cells inline-editable,
 *     and fires the `onCellEdit` / `onTriggerEdit` / `onCounterpartyEdit`
 *     / `onDeleteRow` callbacks the Code-tab supplies. The shared
 *     structure (A/L/E header groups, symbolic balance check, initial
 *     conditions row) is identical in both modes.
 *
 * Shape provided by `agent_godley_rows_get(agent_id)` (editable) or
 * `agent_godley_matrix(agent_id)` (read-only):
 *
 *   {
 *     accounts: { Assets: [{label, asset_kind}], Liabilities: [...], Equity: [...] },
 *     initial_conditions: { [accountLabel]: number },
 *     // read-only:
 *     flows: [{ flow_id, label, cells: { [accountLabel]: signedExpr }, cross_agent }],
 *     // editable:
 *     rows:  [{ template, label, role, cells, overrides, counterparties,
 *               trigger, phase, cross_agent }],
 *   }
 *
 * Balance validation is symbolic-by-substitution (every free variable →
 * 1, then arithmetic-eval the signed expressions; ΣA − ΣL − ΣE ≈ 0).
 */

import { esc } from '../tabs/_util.js';

const ACCOUNT_TYPES = ['Assets', 'Liabilities', 'Equity'];

const SAFE_NUMBERS = /^[\s+\-*/().\d,\w]+$/;


export class GodleyTable {
    constructor(opts = {}) {
        const {
            accounts, flows, rows, initial_conditions = {},
            readonly = true, showInitial = true,
            onCellEdit = null, onTriggerEdit = null,
            onCounterpartyEdit = null, onDeleteRow = null,
            emptyHint = null,
            // Editable EcoSim features (all optional — absent ⇒ unchanged).
            onAddRow = null, onEditRow = null, onLabelEdit = null,
            onAccountAdd = null, onAccountRename = null, onAccountDelete = null,
            onInitialEdit = null,
            // Cell-editor dependency injection: when supplied, the inline cell
            // editor and the double-click pop-out are delegated here so this
            // module stays free of Monaco / modal imports. Shape:
            //   { mountInline(td, ctx), openPopout(ctx) }  // ctx = {value,label,row,idx,commit,cancel}
            editorAdapter = null,
            // Optional cell renderers for the meta columns — the leg model's
            // counterparty (other agent + account + Dr/Cr) and flat trigger
            // differ from the cell model's axis/role/phase chips, so the
            // driving editor can override how those two cells render.
            renderCounterpartyCell = null, renderTriggerCell = null,
            // Show each account cell as a clear Dr/Cr pill + magnitude (the
            // model stays signed; the pill is clickable to flip direction via
            // onDirFlip, and editing edits the magnitude).
            showDrCr = false,
            onDirFlip = null,
            // Which account-type columns to render. Defaults to all three; the
            // editor passes ['Assets','Liabilities'] since Equity is automatic.
            accountTypes = null,
        } = opts;

        this._accounts = ACCOUNT_TYPES.reduce((o, t) => {
            o[t] = Array.isArray(accounts?.[t]) ? accounts[t] : [];
            return o;
        }, {});
        this._initial = initial_conditions || {};
        this._readonly = readonly !== false;
        this._showInitial = showInitial !== false;
        this._onCellEdit = onCellEdit;
        this._onTriggerEdit = onTriggerEdit;
        this._onCounterpartyEdit = onCounterpartyEdit;
        this._onDeleteRow = onDeleteRow;
        this._emptyHint = emptyHint;
        this._onAddRow = onAddRow;
        this._onEditRow = onEditRow;
        this._onLabelEdit = onLabelEdit;
        this._onAccountAdd = onAccountAdd;
        this._onAccountRename = onAccountRename;
        this._onAccountDelete = onAccountDelete;
        this._onInitialEdit = onInitialEdit;
        this._editorAdapter = editorAdapter;
        this._renderCounterpartyCell = renderCounterpartyCell;
        this._renderTriggerCell = renderTriggerCell;
        this._showDrCr = !!showDrCr;
        this._onDirFlip = onDirFlip;
        this._types = (Array.isArray(accountTypes) && accountTypes.length)
            ? accountTypes : ACCOUNT_TYPES;

        // Normalise both shapes onto a single internal row model.
        if (Array.isArray(rows)) {
            this._rows = rows.map((r) => _normRow(r));
        } else {
            this._rows = (Array.isArray(flows) ? flows : []).map((f) => ({
                template:       f.flow_id,
                label:          f.label || f.flow_id,
                role:           'self',
                cells:          f.cells || {},
                overrides:      [],
                counterparties: {},
                trigger:        null,
                phase:          null,
                cross_agent:    !!f.cross_agent,
            }));
        }
        this._hostEl = null;
    }

    /** Render slots for an account type. In editable mode with account-add
     *  enabled, an empty group still yields one placeholder slot (`null`) so
     *  its column and the category "+" header render and a first account of
     *  that type can be created. */
    _slots(type) {
        const list = this._accounts[type];
        if (list.length) return list;
        if (!this._readonly && this._onAccountAdd) return [null];
        return [];
    }

    /** Whether a type's group header should render (has accounts, or is an
     *  add-enabled empty group in editable mode). */
    _showGroup(type) {
        return this._accounts[type].length > 0
            || (!this._readonly && !!this._onAccountAdd);
    }

    /** Total non-balance, non-label columns — drives empty-state colspan. */
    get _colCount() {
        const accts = this._types.reduce(
            (n, t) => n + this._slots(t).length, 0);
        // accounts + (editable ? counterparty + trigger : 0) + balance
        return accts + (this._readonly ? 0 : 2) + 1;
    }

    mount(hostEl) {
        this._hostEl = hostEl;
        hostEl.innerHTML = '';
        hostEl.classList.add('ea-godley');
        if (!this._readonly) hostEl.classList.add('ea-godley--editable');

        const totalAccounts = this._types.reduce(
            (n, t) => n + this._accounts[t].length, 0);
        if (totalAccounts === 0) {
            hostEl.innerHTML =
                '<div class="ea-bp-placeholder__hint">'
                + 'This agent declares no accounts. Add accounts in '
                + 'the Attributes sub-tab to populate the Godley matrix.'
                + '</div>';
            return;
        }

        const tableWrap = document.createElement('div');
        tableWrap.className = 'ea-godley__wrap';
        const tbl = document.createElement('table');
        tbl.className = 'ea-godley__table';
        tbl.appendChild(this._buildHead());
        tbl.appendChild(this._buildBody());
        tableWrap.appendChild(tbl);
        hostEl.appendChild(tableWrap);

        if (this._rows.length === 0) {
            const hint = document.createElement('div');
            hint.className = 'ea-bp-placeholder__hint ea-godley__empty-hint';
            hint.textContent = this._emptyHint || (this._readonly
                ? 'This agent fires no flows yet — add `self.fire(\'<id>\', ...)`'
                  + ' calls in the Code tab and the rows will appear here.'
                : 'No flow rows yet — use “+ Add row”.');
            hostEl.appendChild(hint);
        }

        // "+ Add row" affordance (editable only).
        if (!this._readonly && this._onAddRow) {
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'ea-godley__addrow';
            add.innerHTML = '<span class="material-symbols-outlined">add</span> Add row';
            add.addEventListener('click', () => this._onAddRow());
            hostEl.appendChild(add);
        }
    }

    _buildHead() {
        const editable = !this._readonly;
        const thead = document.createElement('thead');

        const row1 = document.createElement('tr');
        row1.className = 'ea-godley__head-row-1';
        const rowLabel = document.createElement('th');
        rowLabel.className = 'ea-godley__th-flow';
        rowLabel.textContent = 'Accounts →';
        row1.appendChild(rowLabel);
        for (const t of this._types) {
            if (!this._showGroup(t)) continue;
            const span = this._slots(t).length;
            const th = document.createElement('th');
            th.className = `ea-godley__th-group ea-godley__th-group--${t.toLowerCase()}`;
            th.colSpan = span;
            // Category header — label + (editable) an "add account" button.
            if (editable && this._onAccountAdd) {
                const wrap = document.createElement('div');
                wrap.className = 'ea-godley__group-head';
                const lbl = document.createElement('span');
                lbl.textContent = t;
                wrap.appendChild(lbl);
                const add = document.createElement('button');
                add.type = 'button';
                add.className = 'ea-godley__acct-add';
                add.title = `Add ${_singular(t)} account`;
                add.innerHTML = '<span class="material-symbols-outlined">add</span>';
                add.addEventListener('click', () => this._onAccountAdd(t));
                wrap.appendChild(add);
                th.appendChild(wrap);
            } else {
                th.textContent = t;
            }
            row1.appendChild(th);
        }
        if (editable) {
            row1.appendChild(_th('ea-godley__th-meta'));   // Counterparty
            row1.appendChild(_th('ea-godley__th-meta'));   // Trigger
        }
        row1.appendChild(_th('ea-godley__th-balance'));
        thead.appendChild(row1);

        const row2 = document.createElement('tr');
        row2.className = 'ea-godley__head-row-2';
        const flowH = document.createElement('th');
        flowH.className = 'ea-godley__th-flow';
        flowH.textContent = 'Flows ↓';
        row2.appendChild(flowH);
        for (const t of this._types) {
            for (const a of this._slots(t)) {
                row2.appendChild(this._accountHeader(t, a));
            }
        }
        if (editable) {
            const cp = _th('ea-godley__th-account ea-godley__th-meta');
            cp.textContent = 'Counterparty';
            row2.appendChild(cp);
            const tg = _th('ea-godley__th-account ea-godley__th-meta');
            tg.textContent = 'Trigger';
            row2.appendChild(tg);
        }
        const balTh2 = _th('ea-godley__th-balance');
        balTh2.title = 'Row balance: Assets = Liabilities + Equity';
        balTh2.textContent = '=';
        row2.appendChild(balTh2);
        thead.appendChild(row2);

        return thead;
    }

    /** One account-name header cell. `a` is the account or `null` for an
     *  add-enabled empty-group placeholder. Editable mode adds inline
     *  rename and delete affordances. */
    _accountHeader(type, a) {
        const th = document.createElement('th');
        const cls = type.toLowerCase();
        if (!a) {
            th.className = `ea-godley__th-account ea-godley__th-account--${cls} ea-godley__th-account--empty`;
            th.innerHTML = '<span class="ea-godley__no-acct">— no accounts —</span>';
            return th;
        }
        th.className = `ea-godley__th-account ea-godley__th-account--${cls}`;
        if (a.asset_kind) th.title = `asset_kind: ${a.asset_kind}`;
        const editable = !this._readonly;
        if (!editable || (!this._onAccountRename && !this._onAccountDelete)) {
            th.textContent = a.label;
            return th;
        }
        const wrap = document.createElement('div');
        wrap.className = 'ea-godley__acct-head';
        const name = document.createElement('span');
        name.className = 'ea-godley__acct-name';
        name.textContent = a.label;
        wrap.appendChild(name);
        const btns = document.createElement('span');
        btns.className = 'ea-godley__acct-btns';
        if (this._onAccountRename) {
            const ren = document.createElement('button');
            ren.type = 'button';
            ren.className = 'ea-godley__acct-btn';
            ren.title = 'Rename account';
            ren.innerHTML = '<span class="material-symbols-outlined">edit</span>';
            ren.addEventListener('click', (e) => {
                e.stopPropagation();
                this._startAccountRename(wrap, type, a.label);
            });
            btns.appendChild(ren);
        }
        if (this._onAccountDelete) {
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'ea-godley__acct-btn ea-godley__acct-btn--del';
            del.title = 'Delete account';
            del.innerHTML = '<span class="material-symbols-outlined">delete</span>';
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                this._onAccountDelete(type, a.label);
            });
            btns.appendChild(del);
        }
        wrap.appendChild(btns);
        th.appendChild(wrap);
        return th;
    }

    /** Swap an account header into an inline rename input. */
    _startAccountRename(wrap, type, oldLabel) {
        if (wrap.querySelector('input')) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ea-godley__acct-rename';
        input.value = oldLabel;
        wrap.innerHTML = '';
        wrap.appendChild(input);
        input.focus();
        input.select();
        let done = false;
        const commit = () => {
            if (done) return; done = true;
            const next = input.value.trim();
            if (next && next !== oldLabel) this._onAccountRename(type, oldLabel, next);
            else this._refresh();
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
            else if (ev.key === 'Escape') { done = true; this._refresh(); }
        });
    }

    /** Re-render in place (used after an edit cancels or an in-component
     *  mutation). Safe no-op before mount. */
    _refresh() {
        if (this._hostEl) this.mount(this._hostEl);
    }

    /** Swap the flow name into an inline rename input. Empty clears the custom
     *  label (reverting to the derived name). */
    _startLabelEdit(span, row, idx) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ea-godley__flow-name-input';
        input.value = row.label || row.template || '';
        span.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const commit = () => {
            if (done) return; done = true;
            this._onLabelEdit(idx, input.value.trim(), row);
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
            else if (ev.key === 'Escape') { done = true; this._refresh(); }
        });
    }

    _buildBody() {
        const tbody = document.createElement('tbody');
        if (this._showInitial) tbody.appendChild(this._buildInitialRow());
        this._rows.forEach((row, i) => {
            tbody.appendChild(this._buildFlowRow(row, i));
        });
        return tbody;
    }

    _buildInitialRow() {
        const tr = document.createElement('tr');
        tr.className = 'ea-godley__row ea-godley__row--initial';
        const labelTd = document.createElement('td');
        labelTd.className = 'ea-godley__cell-label';
        labelTd.textContent = 'Initial Conditions';
        tr.appendChild(labelTd);
        const numeric = {};
        const editable = !this._readonly && !!this._onInitialEdit;
        for (const t of this._types) {
            for (const a of this._slots(t)) {
                const td = document.createElement('td');
                td.className = `ea-godley__cell ea-godley__cell--${t.toLowerCase()}`;
                if (!a) { td.classList.add('ea-godley__cell--empty'); td.textContent = '—'; tr.appendChild(td); continue; }
                const v = Number(this._initial[a.label] || 0);
                numeric[a.label] = v;
                if (editable) {
                    const input = document.createElement('input');
                    input.type = 'number';
                    input.step = 'any';
                    input.className = 'ea-godley__init-input';
                    input.placeholder = '0';
                    input.value = v ? String(v) : '';
                    input.addEventListener('change', () => {
                        const next = input.value.trim();
                        const num = next === '' ? 0 : Number(next);
                        if (Number.isFinite(num) && num !== v) {
                            this._onInitialEdit(a.label, num);
                        }
                    });
                    td.appendChild(input);
                } else {
                    td.textContent = v ? fmtNum(v) : '';
                }
                tr.appendChild(td);
            }
        }
        if (!this._readonly) {
            tr.appendChild(_blankTd('ea-godley__cell ea-godley__cell--meta'));
            tr.appendChild(_blankTd('ea-godley__cell ea-godley__cell--meta'));
        }
        tr.appendChild(this._balanceCell(this._isInitialBalanced(numeric)));
        return tr;
    }

    _buildFlowRow(row, idx) {
        const editable = !this._readonly;
        const tr = document.createElement('tr');
        tr.className = 'ea-godley__row';
        if (row.cross_agent) tr.classList.add('ea-godley__row--cross');
        if (row.propagated) tr.classList.add('ea-godley__row--inherited');

        // Label cell — flow name, with a delete affordance when editable.
        const labelTd = document.createElement('td');
        labelTd.className = 'ea-godley__cell-label';
        const labelSpan = document.createElement('span');
        labelSpan.className = 'ea-godley__flow-name';
        const nm = row.label || row.template;
        if (nm) {
            labelSpan.textContent = nm;
        } else {
            labelSpan.textContent = 'untitled flow';
            labelSpan.classList.add('ea-godley__flow-name--placeholder');
        }
        // Inline-editable flow name (click to rename).
        if (editable && !row.propagated && this._onLabelEdit) {
            labelSpan.classList.add('ea-godley__flow-name--editable');
            labelSpan.title = 'Click to rename this flow';
            labelSpan.addEventListener('click', (e) => {
                e.stopPropagation();
                this._startLabelEdit(labelSpan, row, idx);
            });
        } else {
            labelSpan.title = row.template;
        }
        labelTd.appendChild(labelSpan);
        if (row.role && row.role !== 'self') {
            const roleChip = document.createElement('span');
            roleChip.className = 'ea-godley__role-chip';
            roleChip.textContent = row.role;
            roleChip.title = `receiver-side row (role: ${row.role})`;
            labelTd.appendChild(roleChip);
        }
        // Godley P6 — propagated mirror rows carry a "from: <firer>" badge
        // and are NOT deletable here (they're derived from the firer; the
        // firer owns the row, the receiver only overrides cells).
        if (row.propagated) {
            const fromChip = document.createElement('span');
            fromChip.className = 'ea-godley__from-chip';
            fromChip.textContent = `from: ${row.from_firer || '?'}`;
            fromChip.title = `Inherited from ${row.from_firer || 'a firer'} — `
                + 'cells are read-only until you override them.';
            labelTd.appendChild(fromChip);
        }
        // Always-visible per-row toolbar: Edit (opens the row dialog) +
        // Delete. Visible (not hover-gated) so they're impossible to miss.
        if (editable && !row.propagated && (this._onEditRow || this._onDeleteRow)) {
            const acts = document.createElement('span');
            acts.className = 'ea-godley__row-actions';
            if (this._onEditRow) {
                const ed = document.createElement('button');
                ed.type = 'button';
                ed.className = 'ea-godley__row-act';
                ed.title = 'Edit this flow';
                ed.innerHTML = '<span class="material-symbols-outlined">edit</span>';
                ed.addEventListener('click', (e) => { e.stopPropagation(); this._onEditRow(idx, row); });
                acts.appendChild(ed);
            }
            if (this._onDeleteRow) {
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'ea-godley__row-act ea-godley__row-act--del';
                del.title = 'Delete this flow';
                del.innerHTML = '<span class="material-symbols-outlined">delete</span>';
                del.addEventListener('click', (e) => { e.stopPropagation(); this._onDeleteRow(idx, row); });
                acts.appendChild(del);
            }
            labelTd.appendChild(acts);
        }
        tr.appendChild(labelTd);

        // Account cells.
        const cells = row.cells || {};
        const overrides = new Set(row.overrides || []);
        for (const t of this._types) {
            for (const a of this._slots(t)) {
                if (!a) {
                    tr.appendChild(_blankTd(
                        `ea-godley__cell ea-godley__cell--${t.toLowerCase()} ea-godley__cell--empty`));
                    continue;
                }
                tr.appendChild(this._accountCell(
                    t, a.label, cells[a.label], overrides.has(a.label),
                    row, idx));
            }
        }

        // Counterparty + Trigger columns (editable only). The driving editor
        // may override how these render (leg-model chips differ from the
        // cell-model's axis/role/phase chips).
        if (editable) {
            if (this._renderCounterpartyCell) {
                tr.appendChild(this._renderCounterpartyCell(row, idx) || this._counterpartyCell(row, idx));
            } else {
                tr.appendChild(this._counterpartyCell(row, idx));
            }
            if (this._renderTriggerCell) {
                tr.appendChild(this._renderTriggerCell(row, idx) || this._triggerCell(row, idx));
            } else {
                tr.appendChild(this._triggerCell(row, idx));
            }
        }

        // The driving editor may supply an explicit verdict (e.g. the leg
        // editor's A−L−E over own + authored counterparty legs); otherwise
        // fall back to the own-cell symbolic check.
        const verdict = (row.balance !== undefined)
            ? row.balance
            : (row.cross_agent ? 'cross-agent' : this._evalRowBalance(cells));
        tr.appendChild(this._balanceCell(verdict));
        return tr;
    }

    _accountCell(type, label, value, isOverride, row, idx) {
        const td = document.createElement('td');
        td.className = `ea-godley__cell ea-godley__cell--${type.toLowerCase()}`;
        // Godley P6 — on a propagated mirror, a cell is read-only UNTIL the
        // user overrides it. An overridden cell edits inline (like an owned
        // cell) and offers a "reset to inherited" affordance.
        const propagated = !!row.propagated;
        const locked = propagated && !isOverride;
        const render = () => {
            td.innerHTML = '';
            const v = value;
            if (v) {
                if (this._showDrCr) {
                    // A +/- delta (does this push the balance up or down) +
                    // the magnitude — the original flows representation. The
                    // signed expression stays in the model; click to flip.
                    const neg = String(v).trim().startsWith('-');
                    const pill = document.createElement('button');
                    pill.type = 'button';
                    pill.className = `ea-godley__delta ea-godley__delta--${neg ? 'neg' : 'pos'}`;
                    pill.textContent = neg ? '−' : '+';
                    const flippable = !this._readonly && this._onDirFlip
                        && row.editable !== false && !locked;
                    pill.title = (neg ? 'Decreases the balance (−)' : 'Increases the balance (+)')
                        + (flippable ? ' — click to flip' : '');
                    if (flippable) {
                        pill.addEventListener('click', (e) => {
                            e.stopPropagation();
                            this._onDirFlip(idx, label, row);
                        });
                    } else {
                        pill.disabled = true;
                        pill.classList.add('ea-godley__delta--static');
                    }
                    td.appendChild(pill);
                    const mag = document.createElement('span');
                    mag.className = 'ea-godley__cell-val';
                    mag.textContent = _stripSign(v);
                    td.appendChild(mag);
                } else {
                    const span = document.createElement('span');
                    span.className = 'ea-godley__cell-val';
                    if (v.startsWith('-')) span.classList.add('ea-godley__cell--neg');
                    else if (v.startsWith('+')) span.classList.add('ea-godley__cell--pos');
                    span.textContent = v;
                    td.appendChild(span);
                }
                if (isOverride) {
                    const dot = document.createElement('span');
                    dot.className = 'ea-godley__override-dot';
                    dot.title = propagated
                        ? 'Overrides the inherited value'
                        : 'Overrides the template default';
                    td.appendChild(dot);
                }
            }
            if (this._readonly || !this._onCellEdit) return;
            if (locked) {
                // Read-only inherited cell — explicit "override" unlock.
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'ea-godley__cell-override';
                btn.title = 'Override this inherited cell';
                btn.innerHTML =
                    '<span class="material-symbols-outlined">edit</span>';
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._openCellEditor(td, value, label, row, idx, render);
                });
                td.appendChild(btn);
            } else if (propagated && isOverride) {
                // "Reset to inherited" — re-submitting the inherited value
                // drops the override (see agent_tab `_onCellEdit`).
                const reset = document.createElement('button');
                reset.type = 'button';
                reset.className = 'ea-godley__cell-reset';
                reset.title = 'Reset to inherited value';
                reset.innerHTML =
                    '<span class="material-symbols-outlined">undo</span>';
                reset.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._onCellEdit(idx, label,
                        (row.template_cells || {})[label] || '', row);
                });
                td.appendChild(reset);
            }
        };
        render();
        if (this._readonly || !this._onCellEdit || locked || row.editable === false) return td;

        td.classList.add('ea-godley__cell--editable');
        td.title = this._editorAdapter
            ? 'Click to edit · double-click to pop out'
            : 'Click to edit this cell expression';
        td.addEventListener('click', (e) => {
            if (td.querySelector('input') || td.querySelector('.ea-godley__cell-monaco')) return;
            e.stopPropagation();
            this._openCellEditor(td, value, label, row, idx, render);
        });
        if (this._editorAdapter?.openPopout) {
            td.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this._editorAdapter.openPopout(this._cellCtx(value, label, row, idx, render));
            });
        }
        return td;
    }

    /** Build the editor-context object shared by inline + pop-out editing.
     *  In Dr/Cr mode the cell edits the MAGNITUDE (the editor re-applies the
     *  sign from the cell's direction), so strip the sign for editing. */
    _cellCtx(value, label, row, idx, render) {
        const editValue = this._showDrCr ? _stripSign(value || '') : (value || '');
        return {
            value: editValue, label, row, idx,
            commit: (next) => {
                const v = String(next ?? '').trim();
                if (v !== editValue) this._onCellEdit(idx, label, v, row);
                else render();
            },
            cancel: render,
        };
    }

    /** Open the inline cell-expression editor in `td`, committing through
     *  `onCellEdit`. Delegates to the injected `editorAdapter` (Monaco) when
     *  supplied; otherwise falls back to a plain text input. Shared by owned
     *  cells (click) and propagated cells (the "override" unlock button). */
    _openCellEditor(td, value, label, row, idx, render) {
        if (td.querySelector('input') || td.querySelector('.ea-godley__cell-monaco')) return;
        const ctx = this._cellCtx(value, label, row, idx, render);
        if (this._editorAdapter?.mountInline) {
            td.innerHTML = '';
            this._editorAdapter.mountInline(td, ctx);
            return;
        }
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ea-godley__cell-input';
        input.value = ctx.value;
        input.placeholder = this._showDrCr ? 'amount' : '+amount';
        td.innerHTML = '';
        td.appendChild(input);
        input.focus();
        input.select();
        let done = false;
        const commit = () => {
            if (done) return; done = true;
            ctx.commit(input.value);
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
            else if (ev.key === 'Escape') { done = true; render(); }
        });
    }

    _counterpartyCell(row, idx) {
        const td = document.createElement('td');
        td.className = 'ea-godley__cell ea-godley__cell--meta ea-godley__cell--cp';
        const cps = row.counterparties || {};
        for (const [role, ref] of Object.entries(cps)) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ea-chip ea-chip--cp';
            const axis = ref?.axis || '?';
            const id = ref?.id || '?';
            chip.innerHTML =
                `<span class="ea-chip__role">${esc(role)}</span>`
                + `<span class="ea-chip__axis">${esc(axis)}</span>`
                + `<span class="ea-chip__id">${esc(id)}</span>`;
            chip.title = `${role} → ${axis}:${id} (click to change)`;
            if (this._onCounterpartyEdit) {
                chip.addEventListener('click', () =>
                    this._onCounterpartyEdit(idx, role, row));
            }
            td.appendChild(chip);
        }
        if (this._onCounterpartyEdit) {
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'ea-chip ea-chip--add';
            add.textContent = '+';
            add.title = 'Add a counterparty role';
            add.addEventListener('click', () =>
                this._onCounterpartyEdit(idx, null, row));
            td.appendChild(add);
        }
        return td;
    }

    _triggerCell(row, idx) {
        const td = document.createElement('td');
        td.className = 'ea-godley__cell ea-godley__cell--meta ea-godley__cell--trigger';
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ea-chip ea-chip--trigger';
        const t = row.trigger || { kind: 'manual' };
        chip.innerHTML =
            `<span class="ea-chip__kind">${esc(_triggerKindLabel(t.kind))}</span>`
            + (t.phase ? `<span class="ea-chip__phase">${esc(_phaseLabel(t.phase))}</span>` : '')
            + (_triggerDetail(t) ? `<span class="ea-chip__detail">${esc(_triggerDetail(t))}</span>` : '');
        chip.title = 'Click to change the trigger';
        if (this._onTriggerEdit) {
            chip.addEventListener('click', () => this._onTriggerEdit(idx, row));
        }
        td.appendChild(chip);
        return td;
    }

    _balanceCell(verdict) {
        const td = document.createElement('td');
        td.className = 'ea-godley__cell-balance';
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined';
        if (verdict === true) {
            td.classList.add('ea-godley__cell-balance--ok');
            icon.textContent = 'check_circle';
            td.title = 'Row balances: Assets = Liabilities + Equity';
        } else if (verdict === false) {
            td.classList.add('ea-godley__cell-balance--bad');
            icon.textContent = 'error';
            td.title = 'Row unbalanced: Assets ≠ Liabilities + Equity';
        } else if (verdict === 'cross-agent') {
            td.classList.add('ea-godley__cell-balance--unknown');
            icon.textContent = 'swap_horiz';
            td.title = 'Cross-agent flow — counter-postings live on the '
                + 'counterparty\'s column. Balance holds system-wide.';
        } else {
            td.classList.add('ea-godley__cell-balance--unknown');
            icon.textContent = 'help';
            td.title = 'Could not symbolically verify (non-numeric expressions).';
        }
        td.appendChild(icon);
        return td;
    }

    _isInitialBalanced(numeric) {
        let a = 0, l = 0, e = 0;
        for (const acc of this._accounts.Assets)
            a += Number(numeric[acc.label] || 0);
        for (const acc of this._accounts.Liabilities)
            l += Number(numeric[acc.label] || 0);
        for (const acc of this._accounts.Equity)
            e += Number(numeric[acc.label] || 0);
        return Math.abs(a - l - e) < 1e-9;
    }

    /** ΣAssets − ΣLiabilities − ΣEquity with every free variable → 1.
     *  Returns true / false / null (null = "couldn't parse, abstain"). */
    _evalRowBalance(cells) {
        const evalCell = (expr) => {
            if (!expr) return 0;
            if (!SAFE_NUMBERS.test(expr)) return NaN;
            const replaced = expr.replace(/[a-zA-Z_][a-zA-Z0-9_]*/g, '1');
            try {
                // eslint-disable-next-line no-new-func
                const v = Function(`"use strict"; return (${replaced});`)();
                return Number.isFinite(v) ? v : NaN;
            } catch {
                return NaN;
            }
        };
        let aSum = 0, lSum = 0, eSum = 0;
        let abstain = false;
        for (const acc of this._accounts.Assets) {
            const v = evalCell(cells[acc.label]);
            if (Number.isNaN(v)) { abstain = true; continue; }
            aSum += v;
        }
        for (const acc of this._accounts.Liabilities) {
            const v = evalCell(cells[acc.label]);
            if (Number.isNaN(v)) { abstain = true; continue; }
            lSum += v;
        }
        for (const acc of this._accounts.Equity) {
            const v = evalCell(cells[acc.label]);
            if (Number.isNaN(v)) { abstain = true; continue; }
            eSum += v;
        }
        if (abstain) return null;
        return Math.abs(aSum - lSum - eSum) < 1e-9;
    }
}


// ─── helpers ─────────────────────────────────────────────────────────

function _normRow(r) {
    return {
        _uid:           r._uid,
        template:       r.template,
        label:          r.label || r.template,
        role:           r.role || 'self',
        editable:       r.editable !== false,
        balance:        ('balance' in r) ? r.balance : undefined,
        cells:          r.cells || {},
        overrides:      Array.isArray(r.overrides) ? r.overrides : [],
        counterparties: r.counterparties || {},
        trigger:        r.trigger || { kind: 'manual' },
        phase:          r.phase || null,
        cross_agent:    !!r.cross_agent,
        // Godley P6 — a propagated receiver-side mirror row (read-only by
        // default; cells overridable per-cell). `from_firer` is the firer
        // archetype; `template_cells` are the inherited (un-overridden)
        // cell values used by "reset to inherited".
        propagated:     !!r.propagated,
        from_firer:     r.from_firer || null,
        template_cells: r.template_cells || {},
    };
}

/** Dr/Cr for a signed amount expression on an account of `type`. A balance
 *  INCREASE (+expr) is Dr on an Asset, Cr on a Liability/Equity. The model
 *  stays signed; this is a derived display annotation. */
function _drcrDir(expr, type) {
    const s = String(expr ?? '').trim();
    const neg = s.startsWith('-');
    const increase = !neg;
    return (increase === (type === 'Assets')) ? 'dr' : 'cr';
}

/** Singular, article-friendly account-type label ("an Asset", "a Liability"). */
function _singular(type) {
    return ({ Assets: 'an Asset', Liabilities: 'a Liability', Equity: 'an Equity' })[type]
        || `a ${type}`;
}

/** Strip a leading `-` / `-(…)` wrapper → the bare magnitude expression. */
function _stripSign(expr) {
    const s = String(expr ?? '').trim();
    if (s.startsWith('-(') && s.endsWith(')')) return s.slice(2, -1).trim();
    if (s.startsWith('-')) return s.slice(1).trim();
    return s;
}

function _th(cls) {
    const th = document.createElement('th');
    th.className = cls;
    return th;
}

function _blankTd(cls) {
    const td = document.createElement('td');
    td.className = cls;
    return td;
}

function _triggerKindLabel(kind) {
    return ({
        manual:     'Manual',
        every_tick: 'Every tick',
        when:       'When',
        for_each:   'For each',
        on_event:   'On event',
    })[kind] || kind || 'Manual';
}

function _phaseLabel(phase) {
    return ({ pre_exec: 'pre', post_exec: 'post' })[phase] || phase || '';
}

function _triggerDetail(t) {
    if (!t) return '';
    if (t.kind === 'when')     return t.expr || '';
    if (t.kind === 'for_each') return t.iterable || '';
    if (t.kind === 'on_event') return t.event || '';
    return '';
}

function fmtNum(v) {
    if (v === 0) return '';
    if (Math.abs(v) >= 1e6) return v.toExponential(2);
    return Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
}


export { esc };
