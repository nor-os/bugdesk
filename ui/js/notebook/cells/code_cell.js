/**
 * CodeCell — EcoLang DSL code editor cell.
 * Multi-line Monaco editor, auto-resizes to content.
 */

import { CellBase } from './cell_base.js';

const HIGHLIGHT_DURATION_MS = 1500;

export class CodeCell extends CellBase {
    #handle = null;
    #highlightDecorations = [];
    #searchDecorations = [];

    _getTabs() {
        return [{ id: 'config', label: 'Code' }];
    }

    async renderBody(bodyEl, cell) {
        const editorContainer = document.createElement('div');
        editorContainer.className = 'code-cell-editor';
        bodyEl.appendChild(editorContainer);

        this.#handle = this._editorFactory.createEditor(
            editorContainer,
            cell.data.source ?? '',
        );

        this._disposers.push(
            this.#handle.onDidChange(() => {
                this._notifyChange({ source: this.#handle.getValue() });
            }),
        );
    }

    getData() {
        return {
            ...this._cell.data,
            source: this.#handle?.getValue() ?? this._cell.data.source ?? '',
        };
    }

    getGeneratedDsl() {
        return this.#handle?.getValue() ?? '';
    }

    focus() {
        this.#handle?.focus();
    }

    /**
     * Reveal and highlight a specific line in the Monaco editor.
     * @param {number} line  1-based line number
     */
    revealLine(line) {
        const editor = this.#handle?.editor;
        if (!editor) return;
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();

        // Transient highlight decoration
        this.#highlightDecorations = editor.deltaDecorations(
            this.#highlightDecorations,
            [{
                range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
                options: {
                    isWholeLine: true,
                    className: 'notebook-line-highlight',
                },
            }],
        );
        setTimeout(() => {
            if (!this.#handle?.editor) return;
            this.#highlightDecorations = this.#handle.editor.deltaDecorations(
                this.#highlightDecorations, [],
            );
        }, HIGHLIGHT_DURATION_MS);
    }

    /**
     * Set Monaco diagnostics markers on this cell's editor.
     * @param {Array<{ startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number, message: string, severity: number }>} markers
     */
    setDiagnostics(markers) {
        const model = this.#handle?.editor?.getModel();
        if (!model) return;
        // Use global monaco reference (loaded by monaco_loader.js)
        const monaco = window.monaco;
        if (!monaco) return;
        monaco.editor.setModelMarkers(model, 'ecosim-validation', markers);
    }

    // ─── Search support (Monaco-specific) ──────────────────────────────────

    getSearchableText() {
        return this.#handle?.getValue() ?? this._cell.data.source ?? '';
    }

    applySearchHighlights(query, activeOffset = -1) {
        const editor = this.#handle?.editor;
        if (!editor) return;
        if (!query) { this.clearSearchHighlights(); return; }

        const model = editor.getModel();
        if (!model) return;

        // Use Monaco's findMatches for accurate range computation
        const isRegex = query instanceof RegExp;
        const searchStr = isRegex ? query.source : query.toString();
        const caseSensitive = isRegex ? !query.flags.includes('i') : false;
        const matches = model.findMatches(searchStr, true, isRegex, caseSensitive, null, false);

        // Map activeOffset (character offset in flat text) to a match index
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
    }

    clearSearchHighlights() {
        const editor = this.#handle?.editor;
        if (!editor) return;
        this.#searchDecorations = editor.deltaDecorations(this.#searchDecorations, []);
    }

    replaceMatch(query, matchIndex, replacement) {
        const editor = this.#handle?.editor;
        const model = editor?.getModel();
        if (!model) return false;

        const isRegex = query instanceof RegExp;
        const searchStr = isRegex ? query.source : query.toString();
        const caseSensitive = isRegex ? !query.flags.includes('i') : false;
        const matches = model.findMatches(searchStr, true, isRegex, caseSensitive, null, true);
        if (matchIndex < 0 || matchIndex >= matches.length) return false;

        const range = matches[matchIndex].range;
        // Support regex capture group references ($1, $2, etc.)
        const replaceText = isRegex
            ? matches[matchIndex].matches[0].replace(query, replacement)
            : replacement;

        editor.executeEdits('notebook-search', [{ range, text: replaceText }]);
        return true;
    }

    replaceAll(query, replacement) {
        const editor = this.#handle?.editor;
        const model = editor?.getModel();
        if (!model) return 0;

        const isRegex = query instanceof RegExp;
        const searchStr = isRegex ? query.source : query.toString();
        const caseSensitive = isRegex ? !query.flags.includes('i') : false;
        const matches = model.findMatches(searchStr, true, isRegex, caseSensitive, null, true);
        if (matches.length === 0) return 0;

        // Apply edits in reverse order to preserve positions
        const edits = [...matches].reverse().map(m => {
            const replaceText = isRegex
                ? m.matches[0].replace(query, replacement)
                : replacement;
            return { range: m.range, text: replaceText };
        });
        editor.executeEdits('notebook-search', edits);
        return matches.length;
    }

    dispose() {
        this.clearSearchHighlights();
        this.#handle?.dispose();
        this.#handle = null;
        this.#highlightDecorations = [];
        this.#searchDecorations = [];
        super.dispose();
    }
}
