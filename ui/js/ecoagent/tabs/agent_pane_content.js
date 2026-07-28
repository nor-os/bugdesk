/**
 * agent_pane_content.js — standalone factories for the three Code-tab panes
 * (Signature / Code / Flows) as first-class WM content kinds.
 *
 * Registering these lets a pane open in a NEW TAB or a NEW WINDOW via
 * `wm.navigate('agent_code' | 'agent_flows' | 'agent_signature', {id})` —
 * and because each mount is a FRESH instance loaded from the bridge, opening
 * one elsewhere never dismounts the copy in the agent tab (the source stays
 * put). Each factory returns `{ mount, destroy }` (the WM contract).
 *
 * They deliberately load their own data from the bridge rather than sharing
 * the agent tab's instance state, so they work identically whether mounted in
 * the agent tab, a tab, or a floating window.
 */

import { esc } from './_util.js';

const _api = () => window.pywebview?.api;

/** Load one archetype's config from agents_list (params/accounts/loop bodies),
 *  used for autocomplete context. Best-effort → {} on any failure. */
async function _loadArch(id) {
    try {
        const list = await _api()?.agents_list?.();
        return (Array.isArray(list) ? list : []).find((a) => a.archetype === id) || {};
    } catch { return {}; }
}

// ── Code pane — whole-file Monaco editor (Python + agent autocomplete) ──────

export function makeAgentCodePane(host, id, ctx = {}) {
    return new _CodePane(host, id, ctx);
}

class _CodePane {
    constructor(host, id, ctx) {
        this.host = host;
        this.id = String(id || '');
        this.logger = ctx.logger || console;
        this._editor = null;
        this._saveTimer = null;
    }

    get title() { return `${this.id} · Code`; }

    async mount() {
        this.host.innerHTML = '';
        this.host.classList.add('ea-pane-content', 'ea-pane-content--code');
        const api = _api();
        const res = await api?.project_file_source?.('archetype', this.id);
        const source = (res?.ok ? res.source : '') || '';
        const a = await _loadArch(this.id);
        let factory = null;
        try {
            const mod = await import('../../notebook/monaco_editor_factory.js');
            factory = await mod.getEditorFactory();
        } catch (err) { this.logger.warn?.('Monaco unavailable', { err }); }
        if (!factory) {
            const ta = document.createElement('textarea');
            ta.className = 'ea-code-editor';
            ta.value = source;
            ta.style.cssText = 'width:100%;height:100%;box-sizing:border-box;';
            this.host.appendChild(ta);
            this._ta = ta;
            ta.addEventListener('input', () => this._scheduleSave(ta.value));
            return;
        }
        const handle = factory.createEditor(this.host, source, {
            language: 'python', noAutoHeight: true, automaticLayout: true,
            minimap: { enabled: false },
            scrollbar: { alwaysConsumeMouseWheel: false },
        });
        this._editor = handle;
        handle.onDidChange(() => this._scheduleSave(handle.getValue()));
        try {
            const comp = await import('../agent_completions.js');
            comp.registerAgentCompletions(factory.monaco);
            const brainKeys = comp.brainKeysFromSources([
                a.init_brain_body, a.observe_body, a.execute_body, a.adjust_body,
            ]);
            comp.attachAgentContext(handle.editor.getModel(), {
                params: a.params || [], accounts: a.accounts || [], brainKeys,
            });
        } catch { /* autocomplete best-effort */ }
    }

    _scheduleSave(src) {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(async () => {
            try { await _api()?.project_file_save?.('archetype', this.id, src); }
            catch (err) { this.logger.warn?.('save failed', { err }); }
        }, 700);
    }

    destroy() {
        clearTimeout(this._saveTimer);
        try { this._editor?.dispose?.(); } catch { /* noop */ }
        this._editor = null;
    }
}

// ── Flows pane — the per-agent booking flows editor ──────────────────────────

export function makeAgentFlowsPane(host, id, ctx = {}) {
    return new _FlowsPane(host, id, ctx);
}

class _FlowsPane {
    constructor(host, id, ctx) {
        this.host = host;
        this.id = String(id || '');
        this.logger = ctx.logger || console;
        this._ed = null;
    }

    get title() { return `${this.id} · Flows`; }

    async mount() {
        this.host.innerHTML = '';
        this.host.classList.add('ea-pane-content', 'ea-pane-content--flows', 'ea-flows-popout');
        const api = _api();
        // SFC-by-construction model (docs/SFC_AUTHORING.md): the pane shows the
        // agent's booking RULES (from <agent>.ledger.json) over its chart, plus
        // the authoring-time linter findings. Amounts/partners live in code.
        const [rg, lint] = await Promise.all([
            api?.agent_ledger_rules_get?.(this.id),
            api?.agent_sfc_lint?.(this.id),
        ]);
        if (!rg || rg.ok === false) {
            this.host.innerHTML =
                `<div class="ea-bp-placeholder__hint">${esc(rg?.error || 'could not load booking rules')}</div>`;
            return;
        }
        // Standalone window has no ea-pane__head to host the actions, so render
        // the same header strip here (add / collapse all / expand all).
        const head = document.createElement('header');
        head.className = 'ea-pane__head ea-flows-popout__head';
        head.innerHTML = `
            <span class="ea-pane__title">Flows</span>
            <span class="ea-pane__kind">booking</span>
            <span class="ea-pane__spacer"></span>
            <button type="button" class="ea-pane__act" data-role="flow-add" title="Add a flow">
                <span class="material-symbols-outlined">add</span></button>
            <button type="button" class="ea-pane__act" data-role="flow-collapse" title="Collapse all flows">
                <span class="material-symbols-outlined">unfold_less</span></button>
            <button type="button" class="ea-pane__act" data-role="flow-expand" title="Expand all flows">
                <span class="material-symbols-outlined">unfold_more</span></button>
        `;
        const body = document.createElement('div');
        body.className = 'ea-flows-popout__body ea-flows-host';
        this.host.appendChild(head);
        this.host.appendChild(body);
        const { LedgerRulesEditor } = await import('../ui/ledger_rules_editor.js');
        this._ed = new LedgerRulesEditor({
            accounts: rg.accounts || { Assets: [], Liabilities: [], Equity: [] },
            initial_conditions: rg.initial_conditions || {},
            rules: rg.rules || [],
            partners: rg.partners || [],
            findings: (lint && lint.ok) ? (lint.findings || []) : [],
            onSave: (rules) => api?.agent_ledger_rules_set?.(this.id, rules),
        });
        this._ed.mount(body);
        head.querySelector('[data-role="flow-add"]')
            ?.addEventListener('click', () => this._ed?.addFlow());
        head.querySelector('[data-role="flow-collapse"]')
            ?.addEventListener('click', () => this._ed?.collapseAll());
        head.querySelector('[data-role="flow-expand"]')
            ?.addEventListener('click', () => this._ed?.expandAll());
    }

    destroy() { this._ed = null; }
}

// ── Signature pane ──────────────────────────────────────────────────────────

export function makeAgentSignaturePane(host, id, ctx = {}) {
    return new _SignaturePane(host, id, ctx);
}

class _SignaturePane {
    constructor(host, id, ctx) {
        this.host = host;
        this.id = String(id || '');
        this.logger = ctx.logger || console;
        this._ctl = null;
    }

    get title() { return `${this.id} · Signature`; }

    async mount() {
        this.host.innerHTML = '';
        this.host.classList.add('ea-pane-content', 'ea-pane-content--signature');
        try {
            const { mountLiveSignaturePanel } = await import('./live_signature_panel.js');
            this._ctl = mountLiveSignaturePanel(this.host, {
                kind: 'agent', id: this.id, vantage: 'inbound',
                getSource: async () => {
                    const r = await _api()?.project_file_source?.('archetype', this.id);
                    return (r?.ok ? r.source : '') || '';
                },
                logger: this.logger,
            });
        } catch (err) {
            this.logger.warn?.('signature panel failed', { err });
            this.host.innerHTML =
                '<div class="ea-bp-placeholder__hint">Signature unavailable.</div>';
        }
    }

    destroy() { try { this._ctl?.destroy?.(); } catch { /* noop */ } this._ctl = null; }
}
