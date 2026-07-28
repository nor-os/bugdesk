/**
 * asset_kind_tab.js — editor for one asset kind.
 *
 * Same shell as sector_tab / kpi_tab:
 *   - ea-detail-header with mountEditableTitle (auto-slugs id behind).
 *   - nb-structured-editor sub-tabs (Settings / Attributes /
 *     Relationships / Code) — matches the agent/market editor layout.
 *   - ea-card sections inside nb-structured-editor__content.
 *
 * A kind owns its own definition: currency + financial-flag + per-kind
 * attributes + Python class. The starter gallery seeds the initial
 * shape at create time; after that there is no parent template /
 * archetype, no inherited defaults, no override-vs-default distinction.
 *
 * Users never type an `id` — they type a `name`, the bridge slugifies.
 *
 * Bridge: assets_list / currencies_list / countries_list /
 *         asset_update / asset_remove / asset_code_*.
 */

import { openConfirm } from '../ui/modal.js';
import { toastError } from '../ui/toast.js';
import { esc, mountEditableTitle } from './_util.js';
import { mountAttributeListEditor }
    from '../../ui/components/attribute_list_editor.js';

// Sub-tab strip — mirrors the agent/market editor layout: Settings
// (chrome), Attributes (list editor), Relationships (shared helper),
// Code (Monaco + live signature panel). The asset_kind tab used to
// bundle everything into one Definition tab, which made the page too
// long to scan and didn't match the editors users would already know.
const SUBTABS = [
    { id: 'settings',      label: 'Settings',      icon: 'tune'        },
    { id: 'attributes',    label: 'Attributes',    icon: 'data_object' },
    { id: 'relationships', label: 'Relationships', icon: 'hub'         },
    { id: 'code',          label: 'Code',          icon: 'code'        },
];



export function makeAssetTab(hostEl, kindId, ctx) {
    return new AssetTab(hostEl, kindId, ctx);
}


class AssetTab {
    constructor(hostEl, kindId, { logger, eventBus, workspaceTabs, tabId } = {}) {
        this.hostEl = hostEl;
        this.kindId = String(kindId || '').trim();
        this.logger = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
        this.eventBus = eventBus ?? null;
        this.workspaceTabs = workspaceTabs ?? null;
        this.tabId = tabId ?? null;

        this._kind = null;
        this._currencies = [];
        this._countries = [];
        this._activeSubTab = 'settings';
        this._saveTimer = null;
        this._titleCtl = null;
        this._root = null;
    }

    async mount() {
        await this._loadData();
        this._render();
    }

    show() {}
    hide() {}

    async refresh(reason) {
        if (reason === 'tick') return;
        await this._loadData();
        if (this._root?.contains(document.activeElement)) return;
        this._render();
    }

    dispose() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._titleCtl?.dispose?.();
        this._disposeCodeEditor();
        try { this._attrsEditor?.dispose?.(); } catch {}
        this._attrsEditor = null;
    }

    // ─── data ──────────────────────────────────────────────────────────

    async _loadData() {
        const api = window.pywebview?.api;
        try {
            const [kinds, currencies, countries] = await Promise.all([
                api?.assets_list?.()  ?? [],
                api?.currencies_list?.()   ?? [],
                api?.countries_list?.()    ?? [],
            ]);
            this._kind = (kinds || []).find((k) => k.id === this.kindId) || null;
            // Asset kind (assets/_kinds/<template>.py) — not a concrete
            // kind; render it through this same editor in 'base' mode (reuse the
            // normal editor for base kinds).
            if (!this._kind) {
                try {
                    const r = await api?.asset_kind_base_get?.(this.kindId);
                    if (r?.ok) { this._kind = r; this._isBase = true; }
                } catch { /* not a base template either */ }
            }
            this._currencies = currencies || [];
            this._countries  = countries  || [];
        } catch (err) {
            this.logger.warn?.('asset_kind_tab load failed', { err });
        }
    }

    // ─── render ────────────────────────────────────────────────────────

    _render() {
        const host = this.hostEl;
        if (!this._kind) {
            host.innerHTML = `
                <div class="ea-asset-kind-tab">
                    <div class="ea-bp-placeholder">
                        <p>Asset kind <code>${esc(this.kindId)}</code>
                           not found — it may have been removed.</p>
                    </div>
                </div>`;
            return;
        }

        host.innerHTML = `
            <div class="ea-asset-kind-tab">
                <header class="ea-detail-header">
                    <div data-role="title-slot"></div>
                    <span class="ea-detail-header__spacer"></span>
                    <button type="button" class="ea-btn ea-btn--small ea-btn--danger"
                            data-action="delete" title="Delete this asset kind">
                        <span class="material-symbols-outlined">delete</span>
                        Delete
                    </button>
                </header>
                <div class="nb-structured-editor__tabs" data-role="subtabs"></div>
                <div class="nb-structured-editor__content" data-role="content"></div>
            </div>
        `;
        this._root = host.querySelector('.ea-asset-kind-tab');

        // Editable title — auto-slugs id behind the scenes.
        const titleSlot = this._root.querySelector('[data-role="title-slot"]');
        this._titleCtl?.dispose?.();
        this._titleCtl = mountEditableTitle(titleSlot, {
            value: (this._kind.name || this._kind.id || '').trim(),
            placeholder: 'Asset kind name',
            tag: 'h2',
            onCommit: (next) => {
                this._kind.name = String(next || '').trim();
                this._scheduleSave();
            },
        });

        // Sub-tab strip — same chrome as sector_tab.
        const subtabs = this._root.querySelector('[data-role="subtabs"]');
        for (const t of SUBTABS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'nb-structured-editor__tab'
                + (t.id === this._activeSubTab ? ' active' : '');
            btn.dataset.subtab = t.id;
            btn.innerHTML = `<span class="material-symbols-outlined">${t.icon}</span> ${t.label}`;
            btn.addEventListener('click', () => this._switchSubTab(t.id));
            subtabs.appendChild(btn);
        }

        this._root.querySelector('[data-action="delete"]')
            ?.addEventListener('click', () => this._onDelete());

        this._renderActiveSubTab();
    }

    _switchSubTab(id) {
        if (this._activeSubTab === id) return;
        this._activeSubTab = id;
        this._root.querySelectorAll('[data-role="subtabs"] .nb-structured-editor__tab')
            .forEach((b) => b.classList.toggle('active', b.dataset.subtab === id));
        this._renderActiveSubTab();
    }

    _renderActiveSubTab() {
        const content = this._root.querySelector('[data-role="content"]');
        if (!content) return;
        // Tear down any prior Monaco editor + attribute editor before
        // swapping content away — they own DOM about to be replaced.
        this._disposeCodeEditor();
        try { this._liveSigCtl?.destroy?.(); } catch {}
        this._liveSigCtl = null;
        try { this._attrsEditor?.dispose?.(); } catch {}
        this._attrsEditor = null;
        content.innerHTML = '';
        switch (this._activeSubTab) {
            case 'relationships': this._renderRelationshipsTab(content); break;
            case 'attributes':    this._renderAttributesTab(content);    break;
            case 'code':          this._renderCodeTab(content);          break;
            case 'settings':
            default:              this._renderSettingsTab(content);
        }
    }

    /** Relationships sub-tab — uses the shared helper so every entity
     *  editor renders relationships the same way (out-refs + inverse). */
    async _renderRelationshipsTab(host) {
        const { mountRelationshipsTab } = await import('./_relationships.js');
        await mountRelationshipsTab(host, {
            entity_kind: 'asset_kind',
            id: this.kindId,
            wm: this.ctx?.wm,
            ctx: this.ctx,
        });
    }

    // ─── Settings sub-tab ─────────────────────────────────────────────

    _renderSettingsTab(host) {
        const k = this._kind;
        const currencyOpts = `
            <option value=""${!k.currency ? ' selected' : ''}>— unitless —</option>
            ${(this._currencies || []).map((c) => `
                <option value="${esc(c.id)}"${k.currency === c.id ? ' selected' : ''}>
                    ${esc(c.id)}
                </option>
            `).join('')}
        `;

        host.innerHTML = `
            <section class="ea-card">
                <h3 class="ea-card__title">How the engine instantiates it</h3>
                <div class="ea-asset-kind-tab__sig-line">
                    <pre class="ea-asset-kind-tab__signature"
                         data-role="signature"></pre>
                    <button type="button" class="ea-icon-btn"
                            data-action="copy-sig"
                            title="Copy to clipboard">
                        <span class="material-symbols-outlined">content_copy</span>
                    </button>
                </div>
            </section>

            <section class="ea-card">
                <h3 class="ea-card__title">Settings</h3>
                <div class="ea-asset-kind-tab__settings-row">
                    <label class="ea-asset-kind-tab__settings-field"
                           title="Value unit. Leave unitless for purely physical kinds.">
                        <span>Currency</span>
                        <select data-field="currency">${currencyOpts}</select>
                    </label>
                    <label class="ea-asset-kind-tab__settings-check"
                           title="SFC-conserved: every issuance has a matching claim.">
                        <input type="checkbox" data-field="is_financial"
                               ${k.is_financial ? 'checked' : ''}>
                        <span>Financial (SFC-conserved per kind)</span>
                    </label>
                </div>
            </section>

            <section class="ea-card">
                <h3 class="ea-card__title">Description</h3>
                <p class="ea-card__hint">
                    A plain-language summary of what this asset kind
                    represents and how it behaves on the balance sheet.
                </p>
                <textarea data-field="description" rows="3"
                          class="ea-asset-kind-tab__description"
                          placeholder="e.g. 5-year German federal bond paying a fixed annual coupon, redeemed at par at maturity.">${esc(k.description || '')}</textarea>
            </section>
        `;
        this._wireFieldInputs(host);
        this._renderSignature();
        host.querySelector('[data-action="copy-sig"]')
            ?.addEventListener('click',
                (e) => this._copySignature(e.currentTarget));
    }

    // ─── Attributes sub-tab ───────────────────────────────────────────

    _renderAttributesTab(host) {
        host.innerHTML = `
            <section class="ea-card">
                <div class="ea-card__head-row">
                    <h3 class="ea-card__title">Attributes</h3>
                    <button type="button" class="ea-btn ea-btn--small"
                            data-action="add-attr"
                            title="Declare a new attribute">
                        <span class="material-symbols-outlined">add</span>
                        Add attribute
                    </button>
                </div>
                <p class="ea-card__hint">
                    The kind's public interface — config inputs the
                    behaviour class receives as kwargs, plus expression-
                    typed outputs the engine evaluates each tick and
                    publishes to bus topic
                    <code>assetkind.${esc(this._kind.id)}.&lt;name&gt;</code>.
                    Typed-ref cells (<code>ref:asset</code>,
                    <code>ref:market</code>, …) keep references stable
                    under rename. Drag to reorder.
                </p>
                <div data-role="attrs-host"></div>
            </section>
        `;
        host.querySelector('[data-action="add-attr"]')
            ?.addEventListener('click', () => this._attrsEditor?.addItem());
        this._mountAttrsEditor();
    }

    // ─── Code sub-tab ─────────────────────────────────────────────────

    _renderCodeTab(host) {
        host.innerHTML = `
            <section class="ea-card ea-asset-kind-tab__code-card"
                     data-card="code">
                <div class="ea-card__head-row">
                    <h3 class="ea-card__title">Behaviour (Python)</h3>
                    <span class="ea-detail-header__spacer"></span>
                </div>
                <p class="ea-card__hint">
                    The class is instantiated once per kind at world build;
                    each <strong>parameter</strong> declared on the
                    Attributes tab (its current value) is passed as a kwarg,
                    with <code>self.params</code> holding the full dict.
                    Hooks <code>accrue</code> / <code>mature</code> /
                    <code>revalue</code> run each tick on every kind that
                    has live holdings.
                </p>
                <div data-role="live-signature"></div>
                <div class="ea-asset-kind-tab__code-editor"
                     data-role="code-host">
                    <div class="ea-bp-placeholder__hint">Loading…</div>
                </div>
            </section>
        `;
        // Live signature panel mounts after the Monaco editor is up so
        // it can hook the editor's change events.
        this._loadCodeIntoEditor().then(() => this._mountLiveSigPanel());
    }

    /** Mount the shared live signature panel above the code editor.
     *  Reads `AssetCode`'s framework contract via `entity_signature`
     *  and re-scans the editor source on `onDidChangeModelContent`. */
    async _mountLiveSigPanel() {
        const host = this._root?.querySelector('[data-role="live-signature"]');
        if (!host) return;
        try { this._liveSigCtl?.destroy?.(); } catch { /* ignore */ }
        try {
            const { mountLiveSignaturePanel } = await import(
                './live_signature_panel.js');
            this._liveSigCtl = mountLiveSignaturePanel(host, {
                kind:    'asset_kind',
                id:      this.kindId,
                editor:  this._codeHandle?.editor || null,
                vantage: 'inbound',
                getSource: () => {
                    const ed = this._codeHandle?.editor;
                    if (ed?.getValue) return ed.getValue();
                    return this._codeFallback?.value || '';
                },
                logger: this.logger,
            });
        } catch (err) {
            this.logger?.warn?.('live signature panel mount failed', { err });
        }
    }

    /** Derive which markets can trade this asset kind, by walking the
     *  registry's market_kind entries: any entry whose
     *  `metadata.supports_assets` contains this kind's id (or `'*'`).
     *  Cross-link both directions. */
    async _loadRelationships() {
        const host = this._root?.querySelector('[data-role="relationships-host"]');
        if (!host) return;
        const api = window.pywebview?.api;
        const k = this._kind;
        let entries = [];
        try {
            entries = await api?.registry_list?.('market_kind') || [];
        } catch (err) {
            this.logger.warn?.('registry_list market_kind failed', { err });
        }
        const myId = String(k.id || '');
        const matches = entries.filter((mk) => {
            const supports = (mk.metadata?.supports_assets) || [];
            return supports.includes('*') || supports.includes(myId);
        });
        if (matches.length === 0) {
            host.innerHTML = '<div class="ea-bp-placeholder__hint">'
                + 'No market kind in the registry declares it can trade this '
                + 'asset kind. Add this kind to a MarketKind\'s '
                + '<code>supports_assets</code> or '
                + '<code>supports_instrument_kinds</code> to wire it up.</div>';
            return;
        }
        host.innerHTML = matches.map((mk) => {
            const why = (mk.metadata?.supports_assets || []).includes(myId)
                ? `directly trades <code>${esc(myId)}</code>`
                : 'accepts any asset kind (CDA wildcard)';
            const reqMethods = (mk.methods || []).length;
            const reqAttrs   = (mk.attributes || []).length;
            return `
                <div class="ea-asset-kind-tab__rel-row" data-kind-id="${esc(mk.id)}">
                    <span class="material-symbols-outlined ea-asset-kind-tab__rel-icon">storefront</span>
                    <span class="ea-asset-kind-tab__rel-id"><code>${esc(mk.id)}</code></span>
                    <span class="ea-asset-kind-tab__rel-label">${esc(mk.label)}</span>
                    <span class="ea-asset-kind-tab__rel-why">${why}</span>
                    <span class="ea-asset-kind-tab__rel-req">
                        ${reqAttrs} required attrs · ${reqMethods} required methods
                    </span>
                </div>
            `;
        }).join('');
    }

    /** Live `ClassName(name=value, …)` preview — generated from the
     *  kind's own attributes list. The class name is CamelCased from
     *  the kind id. Expression-typed attrs are omitted (engine fills
     *  them; not constructor inputs). */
    _renderSignature() {
        const el = this._root.querySelector('[data-role="signature"]');
        if (!el) return;
        const k = this._kind;
        const className = _classNameFor(k.id);
        const attrs = (k.attributes || [])
            .filter((a) => (a?.name || '').trim()
                && a.type !== 'expression');
        const args = attrs.map((a) => {
            const v = (a.value === undefined || a.value === null || a.value === '')
                ? (a.default === undefined || a.default === null ? '' : a.default)
                : a.value;
            return `${a.name}=${_reprArg(v, a.type)}`;
        });
        el.textContent = args.length
            ? `${className}(${args.join(', ')})`
            : `${className}()`;
    }

    async _copySignature(btn) {
        const text = this._root.querySelector('[data-role="signature"]')
            ?.textContent || '';
        if (!text) return;
        try { await navigator.clipboard.writeText(text); }
        catch (err) {
            this.logger.warn?.('clipboard write failed', { err });
            return;
        }
        const icon = btn?.querySelector('.material-symbols-outlined');
        if (icon) {
            icon.textContent = 'check';
            setTimeout(() => { icon.textContent = 'content_copy'; }, 1200);
        }
    }

    /** Wire currency/financial/description inputs on the Settings tab.
     *  The attribute editor and add-attr button live on the Attributes
     *  tab and are wired there. */
    _wireFieldInputs(host) {
        host.querySelectorAll('[data-field]').forEach((el) => {
            const f = el.dataset.field;
            const handler = () => {
                if (f === 'is_financial') {
                    this._kind.is_financial = el.checked;
                } else {
                    this._kind[f] = el.value ?? '';
                }
                this._scheduleSave();
            };
            el.addEventListener('change', handler);
            if (el.tagName === 'TEXTAREA' || el.type === 'text') {
                el.addEventListener('input', handler);
                el.addEventListener('blur', () => this._flush());
            }
        });
    }

    _mountAttrsEditor() {
        const host = this._root.querySelector('[data-role="attrs-host"]');
        if (!host) return;
        try { this._attrsEditor?.dispose?.(); } catch {}
        const api = window.pywebview?.api;
        // Ref resolvers feed the typed-ref dropdowns in the editor.
        // Each one returns a list of `{id, label}` records the editor
        // turns into <option> elements.
        const refResolvers = {
            'ref:asset': async () =>
                ((await api?.assets_list?.()) || []).map(
                    (k) => ({ id: k.id, label: k.name || k.id })),
            'ref:market': async () =>
                ((await api?.markets_list?.()) || []).map(
                    (m) => ({ id: m.id, label: m.id })),
            'ref:sub_sector': async () =>
                ((await api?.sectors_list?.()) || []).map(
                    (s) => ({ id: s.id, label: s.label || s.id })),
            'ref:currency': async () =>
                ((await api?.currencies_list?.()) || []).map(
                    (c) => ({ id: c.id, label: c.label || c.id })),
            'ref:sector': async () =>
                ((await api?.sector_kinds_list?.()) || []).map(
                    (k) => ({ id: k.id, label: k.label || k.id })),
            'ref:agent': async () =>
                ((await api?.agents_list?.()) || []).map(
                    (a) => ({ id: a.archetype, label: a.label || a.archetype })),
        };
        // Aliases for list[ref:*].
        for (const [k, fn] of Object.entries(refResolvers)) {
            const target = k.slice(4);
            refResolvers[`list[ref:${target}]`] = fn;
        }
        this._attrsEditor = mountAttributeListEditor(host, {
            items: this._kind.attributes || [],
            containerId: `assetkind-${this.kindId}-attrs`,
            showColumns: ['name', 'type', 'default', 'value', 'description'],
            refResolvers,
            parentAttributes: [],
            emptyMessage: 'No attributes declared yet. Use "Add attribute" '
                + 'to give this kind a configurable knob or an expression '
                + 'output.',
            onChange: (next) => {
                this._kind.attributes = next;
                this._scheduleSave();
                // Re-renders the kwarg preview on the Settings tab if
                // that's the user's current view; no-op otherwise (the
                // element doesn't exist on Attributes/Code/Relationships).
                this._renderSignature();
            },
            onFlush: () => this._flush(),
        });
    }

    // ─── Code editor plumbing ─────────────────────────────────────────
    //
    // Each asset kind is backed by its own Python class, stored at
    // `<project>/asset_code/<kind_id>.py`. Edits in the editor
    // save back to that file.

    async _loadCodeIntoEditor() {
        const api = window.pywebview?.api;
        let res = null;
        try {
            res = await (this._isBase
                ? api?.asset_kind_base_code_get?.(this.kindId)
                : api?.asset_code_get?.(this.kindId));
        } catch (err) {
            this.logger.warn?.('asset_code_get failed', { err });
        }
        if (!res?.ok) {
            const host = this._root.querySelector('[data-role="code-host"]');
            if (host) host.innerHTML =
                '<div class="ea-bp-placeholder__hint">'
                + (res?.error ? esc(res.error) : 'Code unavailable.')
                + '</div>';
            return;
        }
        this._codeSource = String(res.source || '');
        await this._mountCodeEditor(this._codeSource);
    }

    async _mountCodeEditor(initial) {
        const host = this._root.querySelector('[data-role="code-host"]');
        if (!host) return;
        host.innerHTML = '';
        let factory = null;
        try {
            const mod = await import('../../notebook/monaco_editor_factory.js');
            factory = await mod.getEditorFactory();
        } catch (err) {
            this.logger.warn?.('Monaco unavailable for asset-kind code', { err });
        }
        if (!factory) {
            const ta = document.createElement('textarea');
            ta.className = 'ea-asset-kind-tab__code-fallback';
            ta.value = initial;
            ta.spellcheck = false;
            host.appendChild(ta);
            ta.addEventListener('input', () => this._scheduleCodeSave(ta.value));
            ta.addEventListener('blur', () => this._flushCodeSave());
            this._codeFallback = ta;
            return;
        }
        const handle = factory.createEditor(host, initial, {
            language: 'python',
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            fontSize: 13,
            tabSize: 4,
            insertSpaces: true,
        });
        this._codeHandle = handle;
        const model = handle?.editor?.getModel?.() ?? handle?.getModel?.();
        if (!model) return;
        model.onDidChangeContent(() => {
            this._scheduleCodeSave(model.getValue());
        });
        handle?.editor?.onDidBlurEditorText?.(() => this._flushCodeSave());
    }

    _scheduleCodeSave(source) {
        this._pendingCodeSource = source;
        if (this._codeSaveTimer) clearTimeout(this._codeSaveTimer);
        this._codeSaveTimer = setTimeout(() => this._flushCodeSave(), 600);
    }

    async _flushCodeSave() {
        if (this._codeSaveTimer) {
            clearTimeout(this._codeSaveTimer);
            this._codeSaveTimer = null;
        }
        const source = this._pendingCodeSource;
        if (source === undefined) return;
        this._pendingCodeSource = undefined;
        const api = window.pywebview?.api;
        try {
            const res = await (this._isBase
                ? api?.asset_kind_base_code_set?.(this.kindId, source)
                : api?.asset_code_set?.(this.kindId, source));
            if (res?.ok) {
                this._codeSource = source;
            } else if (res?.error) {
                toastError('Save code failed', res.error);
            }
        } catch (err) {
            toastError('Save code failed', err?.message || String(err));
        }
    }

    _disposeCodeEditor() {
        if (this._codeSaveTimer) {
            clearTimeout(this._codeSaveTimer);
            this._codeSaveTimer = null;
        }
        try { this._codeHandle?.dispose?.(); } catch {}
        this._codeHandle = null;
        this._codeFallback = null;
        this._pendingCodeSource = undefined;
    }

    // ─── persist ──────────────────────────────────────────────────────

    _scheduleSave() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._flush(), 300);
    }

    async _flush() {
        if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
        if (!this._kind) return;
        // Base templates aren't concrete kinds — there's no asset_update target.
        // The Code sub-tab edits the base class directly; the settings/attribute
        // schema is currently edited there too (form write-back is a follow-up).
        if (this._isBase) return;
        const api = window.pywebview?.api;
        try {
            const res = await api?.asset_update?.({
                id:           this.kindId,
                name:         this._kind.name,
                description:  this._kind.description ?? '',
                currency:     this._kind.currency ?? '',
                is_financial: !!this._kind.is_financial,
                attributes:   this._kind.attributes ?? [],
            });
            if (res?.ok === false) {
                toastError('Save failed', res.error || 'update refused');
                return;
            }
            const newId = res?.asset_kind?.id;
            if (newId && newId !== this.kindId) {
                this.kindId = newId;
                this.workspaceTabs?.updateTabLabel?.(this.tabId,
                    this._kind.name || newId);
            }
            this.eventBus?.emit?.('ecoagent:asset_kinds:changed');
            this.workspaceTabs?.notifyChanged?.('asset_kinds');
        } catch (err) {
            this.logger.error?.('asset_kind save failed', { err });
            toastError('Save failed', err?.message || String(err));
        }
    }

    // ─── delete ───────────────────────────────────────────────────────

    async _onDelete() {
        const k = this._kind;
        const ok = await openConfirm({
            title: 'Delete asset kind',
            message: `Delete <strong>${esc(k.name || k.id)}</strong>?
                      Accounts referencing it will become invalid.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (!ok) return;
        const api = window.pywebview?.api;
        try {
            const res = await api?.asset_remove?.(k.id);
            if (res?.ok === false) {
                toastError('Delete failed', res.error || '');
                return;
            }
            this.eventBus?.emit?.('ecoagent:asset_kinds:changed');
            this.workspaceTabs?.closeTab?.(this.tabId);
        } catch (err) {
            this.logger.error?.('asset_kind delete failed', { err });
            toastError('Delete failed', err?.message || String(err));
        }
    }
}


// ─── helpers ──────────────────────────────────────────────────────────

/** CamelCase the kind id so the signature preview matches the class
 *  name exported by `<project>/asset_code/<kind_id>.py`
 *  (`coupon_bond` → CouponBond, `cds` → Cds). Falls back to a generic
 *  name if the kind hasn't picked an id yet. */
function _classNameFor(kindId) {
    const t = String(kindId || '');
    return t.split('_')
        .map((p) => p ? p[0].toUpperCase() + p.slice(1) : '')
        .join('') || 'AssetCode';
}

/** Render one kwarg value the way Python would — strings quoted,
 *  bools capitalised, numbers bare. */
function _reprArg(v, type) {
    if (v === null || v === undefined || v === '') return '…';
    if (type === 'boolean') return v ? 'True' : 'False';
    if (type === 'number' || type === 'integer') return String(v);
    return JSON.stringify(String(v));
}

