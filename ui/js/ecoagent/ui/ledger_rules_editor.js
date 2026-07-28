/**
 * LedgerRulesEditor — the per-agent flows pane (docs/SFC_AUTHORING.md).
 *
 * One flow = a named, amount-free double-entry pattern fired from code:
 *     self.flows["pay_wage"].fire(amount, to)
 *
 * A flow card reads as two grouped halves:
 *   • MY ACCOUNTS — the agent's own legs (account + side).
 *   • OTHER SIDE  — exactly one of: reservoir | a partner (archetype → its
 *     account) | none. The partner archetype and the partner's account sit
 *     side by side, so it reads "a worker, and its Deposits goes +".
 *
 * Net worth (equity) is the derived residual, shown read-only. The reservoir
 * leg mirrors the real-stock own legs automatically. Amount + concrete partner
 * come from `.fire`. Edits autosave and refresh the SFC linter status.
 *
 *   new LedgerRulesEditor({ accounts, rules, partners, findings, onSave })
 *     .mount(host)
 *   // onSave(ruleDicts) -> Promise<{ ok, findings }>
 */

import { esc } from './godley_table.js';

const TYPES = ['Assets', 'Liabilities', 'Equity'];
const FACTOR = { Assets: 1, Liabilities: -1, Equity: 0 };
const SYM = (s) => (s === '-' ? '−' : '+');


export class LedgerRulesEditor {
    constructor({ accounts = {}, rules = [], partners = [], findings = [],
                  onSave = null, initial_conditions = {} } = {}) {
        this._accounts = TYPES.reduce((o, t) => {
            o[t] = Array.isArray(accounts[t]) ? accounts[t] : []; return o;
        }, {});
        this._findings = Array.isArray(findings) ? findings : [];
        this._onSave = onSave;
        this._host = null;
        this._collapsed = new Set();   // flow keys whose card is collapsed

        this._ownAccounts = [];              // {label, kind, type}
        for (const t of ['Assets', 'Liabilities']) {
            for (const a of this._accounts[t]) {
                this._ownAccounts.push({ label: a.label, kind: a.asset_kind || '', type: t });
            }
        }
        this._typeByLabel = {}; this._kindByLabel = {}; this._kindCount = {};
        for (const t of TYPES) for (const a of this._accounts[t]) {
            this._typeByLabel[a.label] = t;
            this._kindByLabel[a.label] = a.asset_kind || '';
            const k = a.asset_kind || ''; this._kindCount[k] = (this._kindCount[k] || 0) + 1;
        }

        // Partner archetypes + their charts (kind → type / account label).
        this._partners = Array.isArray(partners) ? partners : [];
        this._pKindType = {}; this._pKindLabel = {};
        for (const p of this._partners) {
            const kt = {}, kl = {};
            for (const a of (p.accounts || [])) {
                if (a.kind && !(a.kind in kt)) { kt[a.kind] = a.type; kl[a.kind] = a.label; }
            }
            this._pKindType[p.archetype] = kt; this._pKindLabel[p.archetype] = kl;
        }
        const allKinds = new Set(this._ownAccounts.map((a) => a.kind).filter(Boolean));
        allKinds.add('deposits'); allKinds.add('reserves');
        this._kinds = [...allKinds].sort();

        this._rules = (Array.isArray(rules) ? rules : []).map((r) => this._toInternal(r));
    }

    mount(host) { this._host = host; this._render(); }
    destroy() { this._host = null; }

    // Public actions — the host wires these to buttons in its own header
    // (the pane's ea-pane__head), like the Signature pane. No in-body toolbar.
    addFlow() { this._addFlow(); }
    collapseAll() { this._rules.forEach((r) => this._collapsed.add(r.key)); this._render(); }
    expandAll() { this._collapsed.clear(); this._render(); }

    _isMoneyKind(k) {
        return k === 'deposits' || k === 'reserves' || /(_deposits|_reserves)$/.test(k);
    }
    /** A flow whose own legs move money is a bank-routed PAYMENT — the partner's
     *  money account is resolved by the engine's tier plumbing, so the partner
     *  side needs only the archetype (who), not an account. */
    _isMoneyFlow(rule) { return rule.own.some((l) => this._isMoneyKind(l.kind)); }

    // ── model conversion ───────────────────────────────────────────────────────
    _toInternal(r) {
        const own = (r.own || []).map((l) => {
            let label = l.account || '';
            if (!label) { const m = this._ownAccounts.find((a) => a.kind === l.kind); label = m ? m.label : ''; }
            return { kind: l.kind, account: label, sign: l.sign === '-' ? '-' : '+' };
        });
        const counter = r.counter || [];
        let other = 'none', partnerLegs = [];
        if (counter.some((l) => l.party === 'reservoir')) other = 'reservoir';
        else if (counter.length) {
            other = 'partner';
            partnerLegs = counter.map((l) => ({ kind: l.kind, sign: l.sign === '-' ? '-' : '+' }));
        }
        return {
            key: r.key, label: r.label || '', own,
            other, partnerLegs,
            archetypes: Array.isArray(r.counter_archetypes) ? [...r.counter_archetypes] : [],
            // Set by `agent_ledger_rules_get` when this rule is resolved from
            // a parent archetype rather than declared on this agent itself
            // (see `_effective_ledger_rules`, ecoagent/bridge/api.py). Not
            // part of `_serialize()` — it's display-only, client-side.
            inheritedFrom: r.inherited_from || null,
        };
    }

    _serialize() {
        return this._rules.map((r) => {
            const own = r.own.filter((p) => p.account).map((p) => {
                const d = { kind: p.kind, sign: p.sign };
                if ((this._kindCount[p.kind] || 0) > 1) d.account = p.account;
                return d;
            });
            let counter = [];
            if (r.other === 'reservoir') {
                counter = own.map((l) => ({ kind: l.kind, sign: l.sign, party: 'reservoir' }));
            } else if (r.other === 'partner') {
                counter = r.partnerLegs.filter((l) => l.kind).map((l) => ({ kind: l.kind, sign: l.sign }));
            }
            const d = { key: r.key };
            if (r.label) d.label = r.label;
            d.own = own;
            if (counter.length) d.counter = counter;
            if (this._residual(r) !== 0) d.equity = true;
            if (r.other === 'partner' && r.archetypes.length) d.counter_archetypes = [...r.archetypes];
            return d;
        });
    }

    async _persist() {
        if (!this._onSave) return;
        const res = await this._onSave(this._serialize());
        this._findings = (res && res.ok === false)
            ? [{ level: 'error', code: 'save', message: res.error || 'save failed' }]
            : ((res && res.findings) || []);
        this._paintFindings();
    }

    _residual(r) {
        let total = 0;
        for (const p of r.own) {
            const t = this._typeByLabel[p.account];
            if (t === undefined) return null;
            total += (p.sign === '-' ? -1 : 1) * FACTOR[t];
        }
        return total;
    }

    _commonPartnerKinds(r) {
        if (!r.archetypes.length) return null;
        let common = null;
        for (const a of r.archetypes) {
            const ks = new Set(Object.keys(this._pKindType[a] || {}));
            common = common === null ? ks : new Set([...common].filter((k) => ks.has(k)));
        }
        const out = [];
        for (const k of (common || [])) {
            const types = new Set(r.archetypes.map((a) => (this._pKindType[a] || {})[k]));
            if (types.size !== 1) continue;
            out.push({ kind: k, type: [...types][0], label: (this._pKindLabel[r.archetypes[0]] || {})[k] || k });
        }
        out.sort((a, b) => a.label.localeCompare(b.label));
        return out;
    }

    // ── render ─────────────────────────────────────────────────────────────────
    _render() {
        const host = this._host;
        if (!host) return;
        host.innerHTML = '';
        this._findingsEl = document.createElement('div');
        this._findingsEl.className = 'ea-ledger__findings';
        host.appendChild(this._findingsEl);
        this._paintFindings();

        // No in-body toolbar — the host puts the actions in the pane header
        // (ea-pane__head), like the Signature pane. See addFlow/collapseAll/
        // expandAll below.
        const list = document.createElement('div');
        list.className = 'ea-flows';
        this._rules.forEach((r, i) => list.appendChild(this._flowCard(r, i)));
        host.appendChild(list);
    }

    _paintFindings() {
        const el = this._findingsEl;
        if (!el) return;
        el.innerHTML = '';
        const errs = this._findings.filter((f) => f.level === 'error');
        const warns = this._findings.filter((f) => f.level === 'warn');
        if (!errs.length && !warns.length) {
            el.innerHTML = '<span class="ea-ledger__ok">✓ SFC-clean — every flow balances and resolves.</span>';
            return;
        }
        for (const f of [...errs, ...warns]) {
            const row = document.createElement('div');
            row.className = `ea-ledger__finding ea-ledger__finding--${esc(f.level)}`;
            row.innerHTML = `<span class="ea-ledger__finding-code">${esc(f.code)}</span> ${esc(f.message)}`;
            el.appendChild(row);
        }
    }

    /** A signed-amount control: a coloured +/− pill that toggles on click. */
    _signPill(getSign, setSign) {
        const b = document.createElement('button');
        b.type = 'button';
        const paint = () => {
            const s = getSign();
            b.textContent = SYM(s);
            b.className = `ea-sign ea-sign--${s === '-' ? 'neg' : 'pos'}`;
            b.title = s === '-' ? 'decrease this account' : 'increase this account';
        };
        b.addEventListener('click', () => { setSign(getSign() === '-' ? '+' : '-'); paint(); this._persist(); });
        paint();
        return b;
    }

    _flowCard(rule, idx) {
        // Collapsible <details>/<summary> — same technique as the signature panel.
        const card = document.createElement('details');
        card.className = rule.inheritedFrom ? 'ea-flow ea-flow--inherited' : 'ea-flow';
        card.open = !this._collapsed.has(rule.key);
        card.addEventListener('toggle', () => {
            if (card.open) this._collapsed.delete(rule.key); else this._collapsed.add(rule.key);
        });

        // header (summary) — clicking a control inside must NOT toggle.
        const head = document.createElement('summary');
        head.className = 'ea-flow__head';
        head.addEventListener('click', (e) => {
            if (e.target.closest('input, button, select')) e.preventDefault();
        });
        const name = document.createElement('input');
        name.className = 'ea-flow__name'; name.value = rule.key; name.spellcheck = false;
        if (rule.inheritedFrom) {
            name.readOnly = true;
        } else {
            name.addEventListener('change', () => this._renameFlow(idx, name.value.trim(), name));
        }
        head.appendChild(name);
        const hint = document.createElement('code');
        hint.className = 'ea-flow__hint';
        hint.textContent = rule.other === 'partner'
            ? `flows["${rule.key}"].fire(amount, to)`
            : `flows["${rule.key}"].fire(amount)`;
        head.appendChild(hint);
        // Net-worth verdict in the header (visible even when collapsed).
        const res = this._residual(rule);
        const nw = document.createElement('span');
        if (res === null) { nw.className = 'ea-flow__nw ea-flow__nw--none'; nw.textContent = '—'; }
        else if (res > 0) { nw.className = 'ea-flow__nw ea-flow__nw--income'; nw.textContent = '↑ income'; }
        else if (res < 0) { nw.className = 'ea-flow__nw ea-flow__nw--expense'; nw.textContent = '↓ expense'; }
        else { nw.className = 'ea-flow__nw ea-flow__nw--swap'; nw.textContent = 'swap'; }
        head.appendChild(nw);
        if (rule.inheritedFrom) {
            // Read-only — edit it on the parent archetype instead.
            const badge = document.createElement('span');
            badge.className = 'ea-flow__inherited-badge';
            badge.textContent = `inherited from ${rule.inheritedFrom}`;
            head.appendChild(badge);
        } else {
            const del = document.createElement('button');
            del.type = 'button'; del.className = 'tree-node__action-btn ea-flow__del';
            del.title = 'Delete flow';
            del.innerHTML = '<span class="material-symbols-outlined">delete</span>';
            del.addEventListener('click', () => this._deleteFlow(idx));
            head.appendChild(del);
        }
        card.appendChild(head);

        // Two halves side by side — MY ACCOUNTS | OTHER SIDE — so the first
        // leg of each lines up and the card spends width, not height. Wraps
        // back to stacked when the pane is too narrow (CSS flex-wrap).
        const body = document.createElement('div');
        body.className = 'ea-flow__body';

        // ── MY ACCOUNTS ──
        const mineHalf = document.createElement('div');
        mineHalf.className = 'ea-flow__half ea-flow__half--mine';
        mineHalf.appendChild(this._sectionLabel('my accounts'));
        const mine = document.createElement('div');
        mine.className = 'ea-flow__legs';
        rule.own.forEach((leg, li) => mine.appendChild(this._ownLegRow(rule, leg, li)));
        if (!rule.inheritedFrom) {
            mine.appendChild(this._addLink('+ account', () => {
                rule.own.push({ kind: '', account: '', sign: '+' }); this._render(); this._persist();
            }));
        }
        mineHalf.appendChild(mine);
        body.appendChild(mineHalf);

        // ── OTHER SIDE ──
        const otherHalf = document.createElement('div');
        otherHalf.className = 'ea-flow__half ea-flow__half--other';
        otherHalf.appendChild(this._sectionLabel('other side'));
        otherHalf.appendChild(this._otherSide(rule));
        body.appendChild(otherHalf);

        card.appendChild(body);
        return card;
    }

    _sectionLabel(text) {
        const d = document.createElement('div');
        d.className = 'ea-flow__sec'; d.textContent = text;
        return d;
    }
    _addLink(text, onClick) {
        const a = document.createElement('button');
        a.type = 'button'; a.className = 'ea-flow__addlink'; a.textContent = text;
        a.addEventListener('click', onClick);
        return a;
    }

    _ownLegRow(rule, leg, li) {
        const sel = document.createElement('select');
        sel.className = 'ea-flow__sel';
        sel.innerHTML = this._typeGroupedHtml(
            this._ownAccounts.map((a) => ({ value: a.label, label: a.label, type: a.type })),
            leg.account || '', 'account…');
        sel.addEventListener('change', () => {
            leg.account = sel.value; leg.kind = this._kindByLabel[sel.value] || '';
            this._render(); this._persist();
        });
        return this._legCard(sel, leg,
            () => { rule.own.splice(li, 1); this._render(); this._persist(); });
    }

    /** A leg rendered as a card: [account select][± sign][× remove], with a
     *  left accent bar coloured by side (green +, amber −) that flips live
     *  when the sign pill toggles. `onRemove` null → no remove button. */
    _legCard(selEl, leg, onRemove) {
        const row = document.createElement('div');
        const paint = () => {
            row.className = 'ea-flow__leg ea-flow__leg--' + (leg.sign === '-' ? 'neg' : 'pos');
        };
        paint();
        row.appendChild(selEl);
        row.appendChild(this._signPill(() => leg.sign, (s) => { leg.sign = s; paint(); }));
        if (onRemove) row.appendChild(this._removeBtn(onRemove));
        return row;
    }

    _removeBtn(onClick) {
        const x = document.createElement('button');
        x.type = 'button'; x.className = 'tree-node__action-btn ea-flow__rm'; x.title = 'Remove';
        x.innerHTML = '<span class="material-symbols-outlined">close</span>';
        x.addEventListener('click', onClick);
        return x;
    }

    /** <option>s grouped under <optgroup> by account type — the type headers
     *  show directly in the dropdown (recycled from the flows editor). `rows`:
     *  [{value, label, type}]. */
    _typeGroupedHtml(rows, selected, placeholder) {
        const byType = {};
        for (const r of rows) (byType[r.type] = byType[r.type] || []).push(r);
        let html = `<option value="">${esc(placeholder)}</option>`;
        for (const t of TYPES) {
            const list = byType[t];
            if (!list || !list.length) continue;
            html += `<optgroup label="${esc(t)}">`;
            for (const r of list) {
                html += `<option value="${esc(r.value)}"${r.value === selected ? ' selected' : ''}>${esc(r.label)}</option>`;
            }
            html += '</optgroup>';
        }
        return html;
    }

    _otherSide(rule) {
        const wrap = document.createElement('div');
        wrap.className = 'ea-flow__othersplit';

        // A vertical option list (reservoir | a partner | none) — picker style,
        // echoing .ea-bp-flows-picker__list — that dictates the detail shown to
        // its right. Keeping it as a side-list (not a top bar) lets the detail's
        // first row line up with the first leg in MY ACCOUNTS.
        const listEl = document.createElement('ul');
        listEl.className = 'ea-flow__sidelist';
        const OPTS = [
            ['reservoir', 'reservoir', 'all_inclusive'],
            ['partner', 'a partner', 'group'],
            ['none', 'none', 'block'],
        ];
        for (const [val, label, icon] of OPTS) {
            const li = document.createElement('li');
            li.className = 'ea-flow__sideitem' + (rule.other === val ? ' ea-flow__sideitem--active' : '');
            li.innerHTML = `<span class="material-symbols-outlined ea-flow__sideicon">${icon}</span>`
                + `<span class="ea-flow__sidelabel">${esc(label)}</span>`;
            li.addEventListener('click', () => {
                if (rule.other === val) return;
                rule.other = val;
                if (val === 'partner' && !rule.partnerLegs.length) rule.partnerLegs = [{ kind: '', sign: '+' }];
                this._render(); this._persist();
            });
            listEl.appendChild(li);
        }
        wrap.appendChild(listEl);

        // Detail panel — content for the selected option. The partner case
        // splits into "partner" (who) + "account" (which of their accounts)
        // sub-rows, so the two adds no longer collide on one row.
        const detail = document.createElement('div');
        detail.className = 'ea-flow__sidedetail';
        if (rule.other === 'reservoir') {
            detail.appendChild(this._note('mirrors your real-stock leg automatically'));
        } else if (rule.other === 'none') {
            detail.appendChild(this._note('own legs only — must balance'));
        } else {
            this._partnerSubRows(rule, detail);
        }
        wrap.appendChild(detail);
        return wrap;
    }

    /** A labelled sub-row: a fixed-width caption + a content element. Used for
     *  the partner "partner"/"account" split (echoes the section captions). */
    _subRow(label, contentEl) {
        const r = document.createElement('div');
        r.className = 'ea-flow__subrow';
        const l = document.createElement('span');
        l.className = 'ea-flow__subsec'; l.textContent = label;
        r.appendChild(l); r.appendChild(contentEl);
        return r;
    }

    /** The bare "＋" icon button that opens the searchable archetype picker. */
    _pickBtn() {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ea-flow__pickbtn'; b.title = 'Add a partner archetype';
        b.innerHTML = '<span class="material-symbols-outlined">add</span>';
        return b;
    }

    /** OTHER SIDE = a partner. Two sub-rows:
     *   • partner — restriction chips + a searchable "＋" archetype picker.
     *   • account — the partner's account leg(s) + "+ account". The archetype
     *     MUST be picked first (it shapes the available account list). */
    _partnerSubRows(rule, wrap) {
        const who = document.createElement('div');
        who.className = 'ea-flow__subline';
        for (const arch of rule.archetypes) {
            const chip = document.createElement('span');
            chip.className = 'ea-flow__chip ea-flow__chip--on';
            chip.innerHTML = `${esc(arch)} <button type="button" class="ea-flow__chipx" title="remove">×</button>`;
            chip.querySelector('.ea-flow__chipx').addEventListener('click', () => {
                rule.archetypes = rule.archetypes.filter((a) => a !== arch); this._render(); this._persist();
            });
            who.appendChild(chip);
        }
        const avail = this._partners.map((p) => p.archetype).filter((a) => !rule.archetypes.includes(a));
        if (avail.length) {
            const pick = this._pickBtn();
            pick.addEventListener('click', () => this._openArchetypePicker(pick, avail, (val) => {
                rule.archetypes.push(val); this._render(); this._persist();
            }));
            who.appendChild(pick);
        } else if (!rule.archetypes.length) {
            who.appendChild(this._note('no partner archetypes available'));
        }
        wrap.appendChild(this._subRow('partner', who));

        // Account sub-row — needs an archetype first (it shapes the list).
        if (!rule.archetypes.length) {
            wrap.appendChild(this._subRow('account', this._note('pick the archetype first')));
            return;
        }
        const common = this._commonPartnerKinds(rule) || [];
        const acct = document.createElement('div');
        acct.className = 'ea-flow__subcol';
        const legs = document.createElement('div');
        legs.className = 'ea-flow__leglist';
        rule.partnerLegs.forEach((leg, li) => {
            const sel = document.createElement('select');
            sel.className = 'ea-flow__sel';
            const opts = common.map((c) => ({ value: c.kind, label: c.label, type: c.type }));
            // Keep the stored kind selectable even if not in the shared set
            // (e.g. a tier-routed money marker on a tier-0 partner).
            if (leg.kind && !opts.some((o) => o.value === leg.kind)) {
                opts.unshift({ value: leg.kind, label: leg.kind, type: 'Assets' });
            }
            sel.innerHTML = this._typeGroupedHtml(opts, leg.kind || '', 'account…');
            sel.addEventListener('change', () => { leg.kind = sel.value; this._persist(); });
            legs.appendChild(this._legCard(sel, leg, rule.partnerLegs.length > 1
                ? () => { rule.partnerLegs.splice(li, 1); this._render(); this._persist(); }
                : null));
        });
        acct.appendChild(legs);
        acct.appendChild(this._addLink('+ account', () => {
            rule.partnerLegs.push({ kind: '', sign: '+' }); this._render(); this._persist();
        }));
        wrap.appendChild(this._subRow('account', acct));
    }

    /** A searchable popover anchored under `anchorEl`: a search field + a
     *  filtered list of `available` strings. Picking calls onPick(value) and
     *  closes. Styling + keys mirror the tile tab-menu's search list. */
    _openArchetypePicker(anchorEl, available, onPick) {
        const overlay = document.createElement('div');
        overlay.className = 'ea-pick-overlay';
        const menu = document.createElement('div');
        menu.className = 'ea-pick';
        const a = anchorEl.getBoundingClientRect();
        menu.style.left = `${Math.round(a.left)}px`;
        menu.style.top = `${Math.round(a.bottom + 2)}px`;

        const search = document.createElement('div');
        search.className = 'ea-pick__search';
        search.innerHTML = '<span class="material-symbols-outlined">search</span>';
        const input = document.createElement('input');
        input.type = 'text'; input.placeholder = 'search archetype…'; input.spellcheck = false;
        search.appendChild(input);
        menu.appendChild(search);

        const list = document.createElement('div');
        list.className = 'ea-pick__list';
        menu.appendChild(list);

        let rows = [];     // {el, value}
        let cursor = 0;
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
        const pick = (v) => { close(); onPick(v); };
        const paintCursor = () => rows.forEach((r, i) =>
            r.el.classList.toggle('ea-pick__item--cursor', i === cursor));
        const renderList = () => {
            const q = input.value.trim().toLowerCase();
            const matches = available.filter((x) => x.toLowerCase().includes(q));
            list.innerHTML = ''; rows = [];
            if (!matches.length) {
                const e = document.createElement('div');
                e.className = 'ea-pick__empty'; e.textContent = 'no matches';
                list.appendChild(e); return;
            }
            matches.forEach((x, i) => {
                const item = document.createElement('div');
                item.className = 'ea-pick__item'; item.textContent = x;
                item.addEventListener('mouseenter', () => { cursor = i; paintCursor(); });
                item.addEventListener('click', () => pick(x));
                list.appendChild(item); rows.push({ el: item, value: x });
            });
            cursor = 0; paintCursor();
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
            else if (e.key === 'ArrowDown' && rows.length) {
                e.preventDefault(); e.stopPropagation();
                cursor = (cursor + 1) % rows.length; paintCursor(); rows[cursor].el.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'ArrowUp' && rows.length) {
                e.preventDefault(); e.stopPropagation();
                cursor = (cursor - 1 + rows.length) % rows.length; paintCursor(); rows[cursor].el.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter') {
                e.preventDefault(); e.stopPropagation(); if (rows[cursor]) pick(rows[cursor].value);
            }
        };
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
        input.addEventListener('input', renderList);
        document.addEventListener('keydown', onKey, true);

        overlay.appendChild(menu);
        document.body.appendChild(overlay);
        renderList();
        input.focus();

        // Keep the menu inside the viewport's right/bottom edges.
        const m = menu.getBoundingClientRect();
        if (m.right > window.innerWidth - 8) menu.style.left = `${Math.round(window.innerWidth - 8 - m.width)}px`;
        if (m.bottom > window.innerHeight - 8) menu.style.top = `${Math.round(a.top - m.height - 2)}px`;
    }

    _note(t) { const s = document.createElement('span'); s.className = 'ea-flow__note'; s.textContent = t; return s; }

    // ── mutations ──────────────────────────────────────────────────────────────
    _uniqueKey(base) {
        let k = base, n = 1; const have = new Set(this._rules.map((r) => r.key));
        while (have.has(k)) k = `${base}_${n++}`;
        return k;
    }
    _addFlow() {
        this._rules.push({ key: this._uniqueKey('new_flow'), label: '', own: [], other: 'none', partnerLegs: [], archetypes: [] });
        this._render(); this._persist();
        const ins = this._host.querySelectorAll('.ea-flow__name');
        ins[ins.length - 1]?.focus();
    }
    _renameFlow(idx, name, inputEl) {
        if (!name || name === this._rules[idx].key) { inputEl.value = this._rules[idx].key; return; }
        if (this._rules.some((r, i) => i !== idx && r.key === name)) { inputEl.value = this._rules[idx].key; return; }
        this._rules[idx].key = name; this._render(); this._persist();
    }
    _deleteFlow(idx) { this._rules.splice(idx, 1); this._render(); this._persist(); }
}
