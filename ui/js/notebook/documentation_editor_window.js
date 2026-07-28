/**
 * DocumentationEditorWindow — Full-featured markdown editor in a ManagedWindow.
 *
 * Features:
 *   - Full-height Monaco markdown editor (Edit tab)
 *   - Rendered markdown preview (Preview tab)
 *   - Markdown/LaTeX quick-reference sidebar
 */

import { ManagedWindow } from '../ui/components/managed_window.js';
import { createRafResizeObserver } from '../ui/utils/raf_resize_observer.js';
import { markdownToHtml } from './cells/markdown_preview.js';

const HELP_CONTENT = `
<div class="doc-win-help">
    <h3>Markdown</h3>
    <table>
        <tr><td><code># Heading 1</code></td></tr>
        <tr><td><code>## Heading 2</code></td></tr>
        <tr><td><code>### Heading 3</code></td></tr>
        <tr><td><code>**bold**</code></td></tr>
        <tr><td><code>*italic*</code></td></tr>
        <tr><td><code>\`inline code\`</code></td></tr>
        <tr><td><code>- bullet item</code></td></tr>
        <tr><td><code>1. numbered item</code></td></tr>
        <tr><td><code>> blockquote</code></td></tr>
        <tr><td>Blank line = new paragraph</td></tr>
    </table>

    <h3>LaTeX (KaTeX)</h3>
    <table>
        <tr><td><code>$x^2$</code> — inline math</td></tr>
        <tr><td><code>$$\\sum_{i=1}^n x_i$$</code> — display</td></tr>
        <tr><td><code>\\frac{a}{b}</code> — fraction</td></tr>
        <tr><td><code>\\sqrt{x}</code> — square root</td></tr>
        <tr><td><code>\\alpha, \\beta, \\gamma</code> — Greek</td></tr>
        <tr><td><code>\\int_a^b f(x)\\,dx</code> — integral</td></tr>
        <tr><td><code>\\partial</code> — partial derivative</td></tr>
        <tr><td><code>\\cdot, \\times</code> — multiply</td></tr>
        <tr><td><code>\\leq, \\geq, \\neq</code> — comparisons</td></tr>
        <tr><td><code>\\text{label}</code> — text in math</td></tr>
    </table>
</div>
`;

export class DocumentationEditorWindow {
    #win = null;
    #editorFactory = null;
    #handle = null;
    #source = '';
    #onChange = null;
    #activeTab = 'edit';
    #contentEl = null;
    #editorPanel = null;
    #previewPanel = null;
    #helpPanel = null;
    #helpVisible = true;
    #resizeObserver = null;

    /**
     * @param {object} opts
     * @param {string} opts.cellId
     * @param {string} opts.source — initial markdown source
     * @param {object} opts.editorFactory
     * @param {Function} opts.onChange — called with new source string on edits
     * @param {string}   [opts.title] — custom window title
     * @param {Function} [opts.onClose]
     */
    constructor({ cellId, source, editorFactory, onChange, onClose, title }) {
        this.#editorFactory = editorFactory;
        this.#source = source;
        this.#onChange = onChange;

        this.#contentEl = document.createElement('div');
        this.#contentEl.className = 'doc-win-root';

        this.#contentEl.innerHTML = `
            <div class="code-tabs-header">
                <div class="code-tabs">
                    <button class="code-tab active" data-tab="edit">Edit</button>
                    <button class="code-tab" data-tab="preview">Preview</button>
                </div>
                <div class="doc-win-toolbar-spacer"></div>
                <button class="doc-win-help-toggle" title="Toggle help sidebar">
                    <span class="material-symbols-outlined">help_outline</span>
                </button>
            </div>
            <div class="doc-win-body">
                <div class="doc-win-editor-panel" data-panel="edit"></div>
                <div class="doc-win-preview-panel" data-panel="preview" hidden></div>
                <div class="doc-win-help-panel">${HELP_CONTENT}</div>
            </div>
        `;

        this.#editorPanel = this.#contentEl.querySelector('[data-panel="edit"]');
        this.#previewPanel = this.#contentEl.querySelector('[data-panel="preview"]');
        this.#helpPanel = this.#contentEl.querySelector('.doc-win-help-panel');

        // Tab switching
        this.#contentEl.querySelectorAll('.code-tab').forEach(tab => {
            tab.addEventListener('click', () => this.#switchTab(tab.dataset.tab));
        });

        // Help toggle
        this.#contentEl.querySelector('.doc-win-help-toggle').addEventListener('click', () => {
            this.#helpVisible = !this.#helpVisible;
            this.#helpPanel.toggleAttribute('hidden', !this.#helpVisible);
        });

        const detail = title || source.slice(0, 40).trim();
        this.#win = new ManagedWindow({
            id: `doc-editor-${cellId}`,
            title: detail ? `Documentation — ${detail}` : 'Documentation',
            icon: 'description',
            content: this.#contentEl,
            defaultWidth: 900,
            defaultHeight: 600,
            minWidth: 500,
            minHeight: 350,
            canMaximize: true,
            onClose: () => {
                this.#flushEditor();
                this.#resizeObserver?.disconnect();
                this.#resizeObserver = null;
                this.#handle?.dispose();
                this.#handle = null;
                onClose?.();
            },
        });
    }

    show() {
        this.#win.show();
        // Mount editor after window is in DOM so Monaco can measure
        requestAnimationFrame(() => this.#mountEditor());
    }

    close() {
        this.#win.close();
    }

    focus() {
        this.#win.show(); // show() calls bringToFront if already visible
    }

    bringToFront() {
        this.#win.show();
    }

    #mountEditor() {
        if (this.#handle) return;
        this.#handle = this.#editorFactory.createMarkdownEditor(
            this.#editorPanel,
            this.#source,
        );
        this.#handle.onDidChange(() => {
            this.#source = this.#handle.getValue();
            this.#onChange?.(this.#source);
        });

        // Override auto-height: fill the panel instead of growing to content
        this.#editorPanel.style.height = '';
        this.#handle.editor.layout();

        // Re-layout on window resize
        const observer = createRafResizeObserver(() => this.#handle?.editor?.layout());
        observer.observe(this.#editorPanel);
        this.#resizeObserver = observer;
    }

    #flushEditor() {
        if (this.#handle) {
            this.#source = this.#handle.getValue();
            this.#onChange?.(this.#source);
        }
    }

    #switchTab(tabId) {
        this.#activeTab = tabId;

        this.#contentEl.querySelectorAll('.code-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tabId);
        });

        if (tabId === 'edit') {
            this.#editorPanel.hidden = false;
            this.#previewPanel.hidden = true;
            this.#handle?.focus?.();
        } else {
            this.#flushEditor();
            this.#editorPanel.hidden = true;
            this.#previewPanel.hidden = false;
            this.#renderPreview();
        }
    }

    #renderPreview() {
        if (this.#source.trim()) {
            this.#previewPanel.innerHTML = markdownToHtml(this.#source);
        } else {
            this.#previewPanel.innerHTML = '<span class="doc-cell-placeholder">No content</span>';
        }
    }
}
