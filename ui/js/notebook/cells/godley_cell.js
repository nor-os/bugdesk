/**
 * GodleyCell — Godley double-entry accounting table for the notebook.
 *
 * Embeds the shared GodleyTableComponent in standalone mode (no DataManager).
 * Converts between the cell data format and GodleyTableComponent's sectorData format.
 *
 * Cell data format:
 *   accounts: [{ id, name, type, initialValue }]
 *   flows:    [{ id, name, entries: { [accountId]: string } }]
 *
 * Documentation is shown below the table as a markdown preview (click to edit),
 * matching the pattern used in ParameterCell.
 *
 * Tabs: Table | DSL
 */

import { CellBase } from './cell_base.js';
import { GodleyTableComponent } from '../../ui/components/godley_table.js';
import { markdownToHtml } from './markdown_preview.js';

const ACCOUNT_TYPES = ['Assets', 'Liabilities', 'Equity'];

export class GodleyCell extends CellBase {
    #dslHandle = null;
    #docHandle = null;
    #docEditing = false;
    #data = null;
    #table = null;

    _getTabs() {
        return [
            { id: 'config', label: 'Table' },
            { id: 'dsl',    label: 'DSL' },
        ];
    }

    _getExtraActions() {
        return [];
    }

    async renderBody(bodyEl, cell) {
        this.#data = this.#normalise(cell.data);

        bodyEl.innerHTML = `
            <div data-panel="config">
                <div class="godley-header">
                    <div class="godley-field">
                        <label class="godley-label">Title</label>
                        <input class="godley-input" data-field="title"
                               value="${this.#esc(this.#data.title)}" placeholder="e.g. Banking Sector"/>
                    </div>
                    <div class="godley-field">
                        <label class="godley-label">Sector</label>
                        <input class="godley-input" data-field="sector"
                               value="${this.#esc(this.#data.sector)}" placeholder="e.g. Banks"/>
                    </div>
                </div>
                <div class="godley-table-wrap"></div>
                <div class="godley-doc-section">
                    <div class="godley-doc-preview"></div>
                    <div class="godley-doc-editor" hidden></div>
                </div>
            </div>
            <div data-panel="dsl" hidden>
                <div class="godley-dsl-editor"></div>
            </div>
        `;

        bodyEl.querySelectorAll('[data-field]').forEach(el => {
            el.addEventListener('input', () => {
                this.#data[el.dataset.field] = el.value;
                this.#updateTableIdentity();
                this._notifyChange(this.getData());
            });
        });

        // Doc preview click → enter edit mode
        const docPreview = bodyEl.querySelector('.godley-doc-preview');
        docPreview.addEventListener('click', () => this.#enterDocEdit());

        this.#renderDocPreview();

        this.#mountTable(bodyEl.querySelector('.godley-table-wrap'));
    }

    #mountTable(container) {
        this.#table = new GodleyTableComponent({
            sector: this.#data.title || 'Default',
            namespace: this.#data.sector || 'Default',
            mode: 'editable',
            onUpdate: () => {
                this.#syncDataFromTable();
                this._notifyChange(this.getData());
            },
            // No services = standalone mode
        });

        this.#table.setSectorData(this.#toSectorData());
        this.#table.render(container, { forceReload: false });
    }

    #updateTableIdentity() {
        if (!this.#table) return;
        this.#table.sector = this.#data.title || 'Default';
        this.#table.namespace = this.#data.sector || 'Default';
        this.#table.sectorData.sectorName = this.#table.sector;
        this.#table.sectorData.namespace = this.#table.namespace;
    }

    // ─── Documentation (inline below table) ─────────────────────────────────────

    #renderDocPreview() {
        const preview = this._container?.querySelector('.godley-doc-preview');
        if (!preview) return;
        const doc = this.#data.doc ?? '';
        if (doc.trim()) {
            preview.innerHTML = markdownToHtml(doc);
        } else {
            preview.innerHTML = '<span class="godley-doc-placeholder">Click to add documentation…</span>';
        }
    }

    #enterDocEdit() {
        if (this.#docEditing) return;
        this.#docEditing = true;

        const preview = this._container?.querySelector('.godley-doc-preview');
        const editorContainer = this._container?.querySelector('.godley-doc-editor');
        if (!preview || !editorContainer) return;

        preview.hidden = true;
        editorContainer.hidden = false;

        if (!this.#docHandle) {
            this.#docHandle = this._editorFactory?.createMarkdownEditor?.(editorContainer, this.#data.doc ?? '');
            if (this.#docHandle) {
                this._disposers.push(this.#docHandle.onDidChange(() => {
                    this.#data.doc = this.#docHandle.getValue();
                    this._notifyChange(this.getData());
                }));
            }
        } else {
            this.#docHandle.setValue(this.#data.doc ?? '');
        }

        this.#docHandle?.focus?.();

        // Blur detection
        const onFocusOut = () => {
            requestAnimationFrame(() => {
                if (!editorContainer.contains(document.activeElement)) {
                    editorContainer.removeEventListener('focusout', onFocusOut);
                    this.#exitDocEdit();
                }
            });
        };
        editorContainer.addEventListener('focusout', onFocusOut);
    }

    #exitDocEdit() {
        if (!this.#docEditing) return;
        this.#docEditing = false;

        if (this.#docHandle) {
            this.#data.doc = this.#docHandle.getValue?.() ?? '';
        }

        const preview = this._container?.querySelector('.godley-doc-preview');
        const editorContainer = this._container?.querySelector('.godley-doc-editor');

        if (editorContainer) editorContainer.hidden = true;
        if (preview) {
            preview.hidden = false;
            this.#renderDocPreview();
        }
    }

    // ─── Format conversion ──────────────────────────────────────────────────────

    #toSectorData() {
        const accounts = { Assets: [], Liabilities: [], Equity: [] };
        for (const acc of this.#data.accounts) {
            const type = ACCOUNT_TYPES.includes(acc.type) ? acc.type : 'Assets';
            accounts[type].push({
                stockId: acc.id,
                accountName: acc.name,
                initialValue: acc.initialValue ?? 0,
            });
        }

        const flows = this.#data.flows.map(f => ({
            flowId: f.id,
            displayName: f.name,
            entries: { ...f.entries },
        }));

        return {
            sectorName: this.#data.title || 'Default',
            namespace: this.#data.sector || 'Default',
            accounts,
            flows,
        };
    }

    #fromSectorData(sd) {
        const accounts = [];
        for (const type of ACCOUNT_TYPES) {
            for (const acc of (sd.accounts[type] || [])) {
                accounts.push({
                    id: acc.stockId,
                    name: acc.accountName,
                    type,
                    initialValue: acc.initialValue ?? 0,
                });
            }
        }

        const flows = (sd.flows || []).map(f => ({
            id: f.flowId,
            name: f.displayName,
            entries: { ...f.entries },
        }));

        return { accounts, flows };
    }

    #syncDataFromTable() {
        if (!this.#table) return;
        const { accounts, flows } = this.#fromSectorData(this.#table.sectorData);
        this.#data.accounts = accounts;
        this.#data.flows = flows;
    }

    // ─── Tab visibility ─────────────────────────────────────────────────────────

    _onTabChanged(tabId) {
        const bodyEl = this._container?.querySelector('.cell-body');
        if (!bodyEl) return;
        bodyEl.querySelectorAll('[data-panel]').forEach(p => {
            p.toggleAttribute('hidden', p.dataset.panel !== tabId);
        });

        if (tabId === 'dsl') {
            const container = bodyEl.querySelector('.godley-dsl-editor');
            const dsl = this.getGeneratedDsl();
            if (!this.#dslHandle) {
                this.#dslHandle = this._editorFactory?.createDslViewer?.(container, dsl);
            } else {
                this.#dslHandle.setValue(dsl);
            }
        }
    }

    // ─── DSL generation ─────────────────────────────────────────────────────────

    getGeneratedDsl() {
        const d = this.#data;
        const ns = d.sector?.trim();
        if (!ns) return `; Godley table "${d.title || 'Untitled'}" — set sector to generate DSL`;

        const lines = [`; Godley Table: ${d.title || 'Untitled'} (sector ${ns})`, ''];

        // Initial conditions
        for (const acc of d.accounts) {
            const iv = acc.initialValue;
            if (iv == null || iv === '') continue;
            lines.push(`${ns}::${acc.type}[${acc.name}] = ${iv}`);
        }
        if (lines.length > 2) lines.push('');

        // Group flow expressions by account → one equation per account
        /** @type {Map<string, {expr: string, flowName: string}[]>} */
        const byAccount = new Map();
        for (const flow of d.flows) {
            for (const acc of d.accounts) {
                const expr = flow.entries[acc.id]?.trim();
                if (!expr) continue;
                const key = `${acc.type}[${acc.name}]`;
                if (!byAccount.has(key)) byAccount.set(key, []);
                byAccount.get(key).push({ expr, flowName: flow.name || '' });
            }
        }

        for (const [key, terms] of byAccount) {
            const lhs = `d${ns}::${key}/dt`;
            if (terms.length === 1) {
                const comment = terms[0].flowName ? `  ; ${terms[0].flowName}` : '';
                lines.push(`${lhs} = ${terms[0].expr}${comment}`);
            } else {
                // Multi-flow: line break after each '+', flow name as comment
                const parts = terms.map((t, i) => {
                    const comment = t.flowName ? `  ; ${t.flowName}` : '';
                    const prefix = i === 0 ? `${lhs} = ` : `    + `;
                    return `${prefix}${t.expr}${comment}`;
                });
                lines.push(parts.join('\n'));
            }
        }

        return lines.join('\n');
    }

    // ─── Public API ─────────────────────────────────────────────────────────────

    getData() {
        return {
            title:     this.#data.title,
            sector:    this.#data.sector,
            doc:       this.#data.doc,
            accounts:  this.#data.accounts.map(a => ({ ...a })),
            flows:     this.#data.flows.map(f => ({ ...f, entries: { ...f.entries } })),
        };
    }

    // ─── Normalise legacy / new data format ─────────────────────────────────────

    #normalise(data = {}) {
        let _uid = 0;
        const uid = () => `g${Date.now()}-${++_uid}`;

        const base = {
            title:     data.title ?? '',
            sector:    data.sector ?? '',
            doc:       data.doc ?? '',
            accounts:  [],
            flows:     [],
        };

        if (Array.isArray(data.accounts) && data.accounts.length) {
            base.accounts = data.accounts.map(a => {
                const iv = parseFloat(a.initialValue);
                return {
                    id:           a.id   ?? uid(),
                    name:         a.name ?? '',
                    type:         ACCOUNT_TYPES.includes(a.type) ? a.type : 'Assets',
                    initialValue: Number.isFinite(iv) ? iv : 0,
                };
            });
        } else if (Array.isArray(data.cols) && data.cols.length) {
            base.accounts = data.cols.map(name => ({ id: uid(), name, type: 'Assets', initialValue: 0 }));
        } else {
            base.accounts = [
                { id: uid(), name: 'Account1', type: 'Assets', initialValue: 0 },
            ];
        }

        const nameToId = {};
        for (const acc of base.accounts) nameToId[acc.name] = acc.id;

        if (Array.isArray(data.flows) && data.flows.length) {
            base.flows = data.flows.map(f => ({
                id:      f.id   ?? uid(),
                name:    f.name ?? '',
                entries: { ...f.entries },
            }));
        } else if (Array.isArray(data.rows) && data.rows.length) {
            base.flows = data.rows
                .filter(r => r.label && r.label !== '_sum')
                .map(r => {
                    const entries = {};
                    for (const [name, expr] of Object.entries(r.entries ?? {})) {
                        const id = nameToId[name];
                        if (id && expr) entries[id] = expr;
                    }
                    return { id: uid(), name: r.label, entries };
                });
        }

        return base;
    }

    dispose() {
        this.#table?.destroy();
        this.#table = null;
        this.#dslHandle?.dispose();
        this.#docHandle?.dispose();
        this.#dslHandle = null;
        this.#docHandle = null;
        super.dispose();
    }

    #esc(s) {
        return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}
