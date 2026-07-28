/**
 * DocumentationCell — Markdown/text documentation cell.
 * Defaults to rendered preview; click to enter edit mode (Monaco editor).
 * Blurring the editor returns to preview.
 */

import { CellBase } from './cell_base.js';
import { markdownToHtml } from './markdown_preview.js';
import { ParameterCell } from './parameter_cell.js';

export class DocumentationCell extends CellBase {
    #handle = null;
    #editorEl = null;
    #preview = null;
    #isEditing = false;
    #source = '';
    #searchDecorations = [];

    _getTabs() {
        return [{ id: 'config', label: 'Documentation' }];
    }

    async renderBody(bodyEl, cell) {
        this.#source = cell.data.source ?? '';

        bodyEl.innerHTML = `
            <div class="doc-cell-editor" hidden></div>
            <div class="doc-cell-preview"></div>
        `;

        this.#editorEl = bodyEl.querySelector('.doc-cell-editor');
        this.#preview = bodyEl.querySelector('.doc-cell-preview');

        this.#renderPreview();

        // Click anywhere in body → enter edit mode and focus Monaco
        bodyEl.addEventListener('click', () => this.#enterEditMode());

        // Double-click anywhere in body (including Monaco) → open in popout window
        bodyEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this._props.onOpenInWindow?.();
        }, true);
    }

    #enterEditMode() {
        if (this.#isEditing) return;
        this.#isEditing = true;

        // Capture preview height before hiding so editor is at least as tall
        const minH = this.#preview.offsetHeight;

        this.#preview.hidden = true;
        this.#editorEl.hidden = false;

        if (!this.#handle) {
            this.#handle = this._editorFactory.createMarkdownEditor(this.#editorEl, this.#source);

            this._disposers.push(
                this.#handle.onDidChange(() => {
                    this.#source = this.#handle.getValue();
                    this._notifyChange({ source: this.#source });
                }),
            );
        } else {
            this.#handle.setValue(this.#source);
        }

        this.#handle.setMinHeight?.(minH);
        this.#handle.updateHeight?.();
        this.#handle.focus?.();

        // Blur detection: when focus leaves the editor, return to preview
        const onFocusOut = (e) => {
            requestAnimationFrame(() => {
                if (!this.#editorEl.contains(document.activeElement)) {
                    this.#editorEl.removeEventListener('focusout', onFocusOut);
                    this.#exitEditMode();
                }
            });
        };
        this.#editorEl.addEventListener('focusout', onFocusOut);
    }

    #exitEditMode() {
        if (!this.#isEditing) return;
        this.#isEditing = false;

        // Capture latest value
        if (this.#handle) {
            this.#source = this.#handle.getValue();
        }

        this.#editorEl.hidden = true;
        this.#preview.hidden = false;
        this.#renderPreview();
    }

    #renderPreview() {
        if (!this.#preview) return;
        if (this.#source.trim()) {
            this.#preview.innerHTML = markdownToHtml(this.#source, {
                resolveDirective: (tag, id) => this.#resolveDirective(tag, id),
                resolveCitation:  (key) => this.#resolveCitation(key),
            });
            this.#bindCrossRefClicks();
        } else {
            this.#preview.innerHTML = '<span class="doc-cell-placeholder">Click to add documentation…</span>';
        }
    }

    /**
     * Resolve embedded directives: {{params:id}}, {{fig:id}}, {{tbl:id}}, {{ref:id}}.
     * @param {string} tag — directive type
     * @param {string} id  — cell ID
     * @returns {string|null} HTML to embed, or null to leave as-is
     */
    #resolveDirective(tag, id) {
        const cells = this._props?.getCells?.() ?? [];
        const numbering = this._props?.getNumbering?.() ?? new Map();

        switch (tag) {
            case 'params': {
                const cell = cells.find(c => c.id === id && c.type === 'parameter');
                if (!cell) return null;
                const parameters = cell.data?.parameters ?? [];
                if (!parameters.length) return null;
                const scenarioCtx = this._props?.getScenarioContext?.() ?? {};
                const isMC = (scenarioCtx.monteCarlo?.runs ?? 0) > 0;
                return ParameterCell.renderAsTable(parameters, { showDistribution: isMC });
            }

            case 'fig': {
                const cell = cells.find(c => c.id === id && (c.type === 'plot' || c.type === 'loops'));
                if (!cell) return `<span class="md-xref md-xref--broken" title="Figure not found: ${id}">Figure ??</span>`;
                const num = numbering.get(id);
                const caption = cell.data?.description ?? cell.data?.caption ?? '';
                const label = `Figure ${num?.displayNum ?? '?'}`;
                return `<a class="md-xref md-xref--fig" href="#" data-scroll-to="${id}" title="${caption}">${label}</a>`;
            }

            case 'tbl': {
                const cell = cells.find(c => c.id === id && c.type === 'data-table');
                if (!cell) return `<span class="md-xref md-xref--broken" title="Table not found: ${id}">Table ??</span>`;
                const num = numbering.get(id);
                const caption = cell.data?.caption ?? '';
                const label = `Table ${num?.displayNum ?? '?'}`;
                return `<a class="md-xref md-xref--tbl" href="#" data-scroll-to="${id}" title="${caption}">${label}</a>`;
            }

            case 'ref': {
                const cell = cells.find(c => c.id === id && c.type === 'heading');
                if (!cell) return `<span class="md-xref md-xref--broken" title="Heading not found: ${id}">Section ??</span>`;
                const num = numbering.get(id);
                const title = cell.data?.title ?? '';
                const label = num?.displayNum ? `Section ${num.displayNum}` : title;
                return `<a class="md-xref md-xref--ref" href="#" data-scroll-to="${id}" title="${title}">${label}</a>`;
            }

            default:
                return null;
        }
    }

    /**
     * Resolve [@citeKey] → { num, cellId } for inline citation rendering.
     * Scans literature cells in siblings for matching citeKeys.
     */
    #resolveCitation(key) {
        const cells = this._props?.getCells?.() ?? [];

        // Collect all literature entries from sibling cells
        const allEntries = [];
        let litCellId = null;
        for (const cell of cells) {
            if (cell.type !== 'literature') continue;
            if (!litCellId) litCellId = cell.id; // first literature cell for scrolling
            for (const entry of (cell.data?.entries ?? [])) {
                if (entry.citeKey) allEntries.push({ entry, cellId: cell.id });
            }
        }

        // Build numbering: scan all doc cells for citation order
        const citePattern = /\[@([^\]]+)\]/g;
        const knownKeys = new Set(allEntries.map(e => e.entry.citeKey));
        const ordered = [];
        for (const cell of cells) {
            if (cell.type !== 'documentation') continue;
            const src = cell.data?.source ?? '';
            let m;
            while ((m = citePattern.exec(src)) !== null) {
                const k = m[1].trim();
                if (knownKeys.has(k) && !ordered.includes(k)) ordered.push(k);
            }
        }
        // Add unreferenced entries after referenced ones
        for (const { entry } of allEntries) {
            if (!ordered.includes(entry.citeKey)) ordered.push(entry.citeKey);
        }

        const idx = ordered.indexOf(key);
        if (idx < 0) return null;

        const match = allEntries.find(e => e.entry.citeKey === key);
        return { num: idx + 1, cellId: match?.cellId ?? litCellId };
    }

    /**
     * Attach click-to-scroll handlers for all cross-reference links in the preview.
     * Targets both `md-xref` (directives) and `md-cite-link` (citations).
     */
    #bindCrossRefClicks() {
        if (!this.#preview) return;
        this.#preview.querySelectorAll('[data-scroll-to]').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation(); // don't trigger edit mode
                this._props?.scrollToCell?.(link.dataset.scrollTo);
            });
        });
    }

    refreshContent() {
        // Re-render preview so embedded parameter tables and cross-refs update
        if (!this.#isEditing) {
            this.#renderPreview();
        }
    }

    getData() {
        return {
            ...this._cell.data,
            source: this.#handle?.getValue() ?? this.#source,
        };
    }

    focus() {
        this.#enterEditMode();
    }

    // ─── Search support ─────────────────────────────────────────────────────

    getSearchableText() {
        return this.#handle?.getValue() ?? this.#source;
    }

    applySearchHighlights(query, activeOffset = -1) {
        // If in edit mode with Monaco, use decorations; otherwise highlight preview DOM
        if (this.#isEditing && this.#handle) {
            this.clearSearchHighlights();
            if (!query) return;

            const editor = this.#handle.editor;
            const model = editor?.getModel();
            if (!model) return;

            const isRegex = query instanceof RegExp;
            const searchStr = isRegex ? query.source : query.toString();
            const caseSensitive = isRegex ? !query.flags.includes('i') : false;
            const matches = model.findMatches(searchStr, true, isRegex, caseSensitive, null, false);

            let activeMatchIdx = -1;
            if (activeOffset >= 0) {
                for (let i = 0; i < matches.length; i++) {
                    const r = matches[i].range;
                    const matchStart = model.getOffsetAt({ lineNumber: r.startLineNumber, column: r.startColumn });
                    if (matchStart === activeOffset) { activeMatchIdx = i; break; }
                }
            }

            this.#searchDecorations = editor.deltaDecorations(
                this.#searchDecorations,
                matches.map((m, i) => ({
                    range: m.range,
                    options: {
                        className: i === activeMatchIdx ? 'nb-search-match--active' : 'nb-search-match',
                        isWholeLine: false,
                    },
                })),
            );
        } else {
            // Preview mode — use base class DOM highlighting on the preview element
            super.applySearchHighlights(query, activeOffset);
        }
    }

    clearSearchHighlights() {
        // Clear Monaco decorations
        if (this.#handle?.editor) {
            this.#searchDecorations = this.#handle.editor.deltaDecorations(this.#searchDecorations, []);
        }
        // Clear DOM marks in preview
        super.clearSearchHighlights();
    }

    replaceMatch(query, matchIndex, replacement) {
        // Replace works on the source text, not the preview
        const text = this.#source;
        const isRegex = query instanceof RegExp;
        const re = isRegex ? new RegExp(query.source, query.flags.replace('g', '')) : new RegExp(query.toString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), query.flags?.replace('g', '') ?? 'i');

        let count = 0;
        const newText = text.replace(new RegExp(re.source, re.flags + 'g'), (match, ...args) => {
            if (count++ === matchIndex) return isRegex ? match.replace(query, replacement) : replacement;
            return match;
        });

        if (newText !== text) {
            this.#source = newText;
            this.#handle?.setValue(this.#source);
            this._notifyChange({ source: this.#source });
            this.#renderPreview();
            return true;
        }
        return false;
    }

    replaceAll(query, replacement) {
        const text = this.#source;
        const isRegex = query instanceof RegExp;
        const re = isRegex ? new RegExp(query.source, query.flags.includes('g') ? query.flags : query.flags + 'g') : new RegExp(query.toString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

        let count = 0;
        const newText = text.replace(re, () => { count++; return replacement; });
        if (count > 0) {
            this.#source = newText;
            this.#handle?.setValue(this.#source);
            this._notifyChange({ source: this.#source });
            this.#renderPreview();
        }
        return count;
    }

    dispose() {
        this.clearSearchHighlights();
        this.#handle?.dispose();
        this.#handle = null;
        super.dispose();
    }
}
