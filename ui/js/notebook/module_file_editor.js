/**
 * ModuleFileEditor
 *
 * Dedicated editor for .edf module files in the notebook page.
 *
 * Features:
 *   - Detail header with module name (derived from filename), renameable
 *   - Metadata section: description field, imports list
 *   - Validation badge in header (function count)
 *   - Single Monaco editor for function definitions + comments
 *   - Empty state with template insertion for new modules
 *   - Strips directives (.MODULE, .EXPORT, .DESCRIPTION, .IMPORT, .INPUTS, .OUTPUTS)
 *     from display — auto-generates them on save
 *   - Readonly mode for builtin modules
 *   - Blocks manual entry of .MODULE / .END directives
 *
 * Data flow:
 *   Load:  raw .edf string → strip directives → Monaco editor
 *   Save:  Monaco content → prepend .MODULE + append .EXPORT → raw .edf string
 */

import { createDetailHeader, updateDetailHeader } from '../ui/components/detail_header.js';
import { getEditorFactory } from './monaco_editor_factory.js';

// Directive patterns (case-insensitive, whole-line)
const DIRECTIVE_RE = /^\s*\.(MODULE|DESCRIPTION|IMPORT|EXPORT|INPUTS|OUTPUTS|END)\b.*$/i;

// Function definition patterns for export detection
const FUNC_DEF_RE        = /^(\w+)\s+(?:\w+\s+)*\w+\s*=\s*.+$/;      // func a b = expr
const FUNC_DEF_NOARG_RE  = /^(\w+)\s*=\s*.+$/;                         // const = expr
const FUNC_MULTILINE_RE  = /^(\w+)\s+(?:(?:\w+\s+)*\w+)?\s*=$/;       // func a b =

const MODULE_TEMPLATE = `# Define module functions using EcoLang syntax
# Example:
#   growth_rate birth_rate death_rate population =
#     (birth_rate - death_rate) * population
#
#   return(growth_rate)

`;

/**
 * Parse raw .edf content: extract metadata and return the function body
 * (everything that is NOT a directive line).
 */
function parseEdf(raw) {
    const lines = (raw || '').split('\n');
    const bodyLines = [];
    let moduleName = null;
    let description = null;
    const imports = [];
    const exports = [];

    for (const line of lines) {
        const trimmed = line.trim();

        const m = trimmed.match(/^\s*\.MODULE\s+(\w+)/i);
        if (m) { moduleName = m[1]; continue; }

        const d = trimmed.match(/^\s*\.DESCRIPTION\s+(.+)/i);
        if (d) { description = d[1].trim(); continue; }

        const imp = trimmed.match(/^\s*\.IMPORT\s+(.+)/i);
        if (imp) { imports.push(...imp[1].split(',').map(s => s.trim())); continue; }

        const exp = trimmed.match(/^\s*\.EXPORT\s+(.+)/i);
        if (exp) { exports.push(...exp[1].split(',').map(s => s.trim())); continue; }

        // Skip legacy .INPUTS/.OUTPUTS/.END/.READONLY
        if (/^\s*\.(INPUTS|OUTPUTS|END|READONLY)\b/i.test(trimmed)) continue;

        bodyLines.push(line);
    }

    // Trim leading/trailing blank lines from body
    while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
    while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();

    return {
        moduleName,
        description,
        imports,
        exports,
        body: bodyLines.join('\n'),
    };
}

/**
 * Reconstruct full .edf content from module name + editor body.
 * Auto-discovers exported function names from the body.
 */
function buildEdf(moduleName, body, { description, imports } = {}) {
    const lines = [];

    lines.push(`.MODULE ${moduleName}`);
    if (description) lines.push(`.DESCRIPTION ${description}`);
    if (imports?.length) lines.push(`.IMPORT ${imports.join(', ')}`);
    lines.push('');

    lines.push(body);

    // Auto-export: extract all top-level function names
    const funcNames = extractFunctionNames(body);
    if (funcNames.length) {
        lines.push('');
        // Emit in chunks of 8 to keep lines readable
        for (let i = 0; i < funcNames.length; i += 8) {
            lines.push(`.EXPORT ${funcNames.slice(i, i + 8).join(', ')}`);
        }
    }

    return lines.join('\n') + '\n';
}

/**
 * Extract top-level function names from editor body text.
 */
function extractFunctionNames(body) {
    const names = [];
    for (const line of (body || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        // Skip indented lines (multi-line function bodies)
        if (line.match(/^[ \t]/) && line.trim()) continue;

        let m = trimmed.match(FUNC_DEF_RE);
        if (m) { names.push(m[1]); continue; }

        m = trimmed.match(FUNC_MULTILINE_RE);
        if (m) { names.push(m[1]); continue; }

        m = trimmed.match(FUNC_DEF_NOARG_RE);
        if (m) { names.push(m[1]); continue; }
    }
    return names;
}

export class ModuleFileEditor {
    /** @type {HTMLElement} */
    #container = null;

    /** @type {HTMLElement} */
    #rootEl = null;

    /** @type {HTMLElement} */
    #headerEl = null;

    /** @type {HTMLElement} */
    #metaEl = null;

    /** @type {object} EditorHandle from MonacoEditorFactory */
    #editorHandle = null;

    /** @type {string} Module name (derived from filename) */
    #moduleName = '';

    /** @type {string|null} Description from .DESCRIPTION directive */
    #description = null;

    /** @type {string[]} Imports from .IMPORT directive */
    #imports = [];

    /** @type {boolean} */
    #readonly = false;

    /** @type {Function|null} */
    #onChangeCallback = null;

    /** @type {Function|null} */
    #onRenameCallback = null;

    /** @type {object|null} Monaco content change disposable */
    #contentDisposable = null;

    constructor() {}

    /**
     * Mount the module file editor.
     *
     * @param {HTMLElement} container
     * @param {{
     *   content: string,
     *   moduleName: string,
     *   filePath?: string,
     *   projectName?: string,
     *   readonly?: boolean,
     *   onChange?: Function,
     *   onRename?: (newName: string) => Promise<{success: boolean, newValue?: string}>,
     * }} props
     */
    async mount(container, { content, moduleName, readonly = false, onChange, onRename } = {}) {
        this.#container = container;
        this.#readonly = readonly;
        this.#onChangeCallback = onChange ?? null;
        this.#onRenameCallback = onRename ?? null;
        this.#moduleName = moduleName || 'Untitled';

        // Parse .edf content
        const parsed = parseEdf(content);
        this.#description = parsed.description;
        this.#imports = parsed.imports;

        await this.#render(parsed.body);
    }

    /** Return the full .edf string for saving. */
    getValue() {
        const body = this.#editorHandle?.getValue() ?? '';
        return buildEdf(this.#moduleName, body, {
            description: this.#description,
            imports: this.#imports,
        });
    }

    /** Update module name (called when file is renamed externally). */
    setModuleName(name) {
        this.#moduleName = name;
        const nameEl = this.#headerEl?.querySelector('.detail-header__name');
        if (nameEl) nameEl.textContent = name;
    }

    /** Get current function count for external badge display. */
    getFunctionCount() {
        const body = this.#editorHandle?.getValue() ?? '';
        return extractFunctionNames(body).length;
    }

    get isDirty() { return false; /* managed by parent */ }

    dispose() {
        this.#contentDisposable?.dispose();
        this.#editorHandle?.dispose();
        this.#editorHandle = null;
        this.#container = null;
    }

    // ─── Rendering ────────────────────────────────────────────────────────────

    async #render(body) {
        this.#container.innerHTML = '';

        const root = document.createElement('div');
        root.className = 'editor-chrome';
        this.#rootEl = root;

        // Detail header with validation badge
        this.#renderHeader(body);
        root.appendChild(this.#headerEl);

        // Metadata section (description + imports + signatures)
        this.#metaEl = this.#buildMetaSection();
        root.appendChild(this.#metaEl);

        // Check if body is empty → show empty state or Monaco
        const hasContent = body.trim().length > 0;

        if (!hasContent && !this.#readonly) {
            // Empty state
            const emptyState = this.#buildEmptyState();
            root.appendChild(emptyState);
            this.#container.appendChild(root);
        } else {
            // Monaco editor container
            const editorContainer = document.createElement('div');
            editorContainer.className = 'module-file-editor__monaco';
            root.appendChild(editorContainer);
            this.#container.appendChild(root);

            await this.#mountMonaco(editorContainer, body);
        }
    }

    #renderHeader(body) {
        const funcCount = extractFunctionNames(body).length;
        const badges = this.#buildHeaderBadges(funcCount);

        this.#headerEl = createDetailHeader({
            title: this.#moduleName,
            badges,
            renameable: !this.#readonly,
            onRename: this.#readonly ? undefined : async (newName) => {
                if (this.#onRenameCallback) {
                    return await this.#onRenameCallback(newName);
                }
                return { success: false };
            },
        });
    }

    #buildHeaderBadges(funcCount) {
        const badges = [{ text: 'Module', icon: 'extension' }];
        if (this.#readonly) {
            badges.push({ text: 'Built-in', className: 'detail-header__badge--readonly' });
        }
        if (funcCount > 0) {
            badges.push({
                text: `${funcCount} function${funcCount !== 1 ? 's' : ''}`,
                icon: 'functions',
                className: 'detail-header__badge--valid',
            });
        }
        return badges;
    }

    #updateHeaderBadge() {
        const body = this.#editorHandle?.getValue() ?? '';
        const funcCount = extractFunctionNames(body).length;
        const badges = this.#buildHeaderBadges(funcCount);

        updateDetailHeader(this.#headerEl, {
            title: this.#moduleName,
            badges,
            renameable: !this.#readonly,
            onRename: this.#readonly ? undefined : async (newName) => {
                if (this.#onRenameCallback) {
                    return await this.#onRenameCallback(newName);
                }
                return { success: false };
            },
        });
    }

    // ─── Metadata section ────────────────────────────────────────────────────

    #buildMetaSection() {
        const meta = document.createElement('div');
        meta.className = 'module-file-editor__meta';

        // Description row
        const descRow = document.createElement('div');
        descRow.className = 'module-file-editor__meta-row';

        const descLabel = document.createElement('span');
        descLabel.className = 'module-file-editor__meta-label';
        descLabel.textContent = 'Description';
        descRow.appendChild(descLabel);

        const descInput = document.createElement('input');
        descInput.type = 'text';
        descInput.className = 'module-file-editor__desc-input';
        descInput.placeholder = 'Brief description of this module\u2026';
        descInput.value = this.#description ?? '';
        descInput.readOnly = this.#readonly;
        descInput.addEventListener('change', () => {
            this.#description = descInput.value.trim() || null;
            this.#onChangeCallback?.();
        });
        descRow.appendChild(descInput);
        meta.appendChild(descRow);

        return meta;
    }

    // ─── Empty state ─────────────────────────────────────────────────────────

    #buildEmptyState() {
        const el = document.createElement('div');
        el.className = 'module-file-editor__empty-state';

        el.innerHTML = `
            <span class="material-symbols-outlined">extension</span>
            <p>Define reusable functions in EcoLang syntax.<br>Functions are auto-exported for use in namespaces.</p>
        `;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'editor-empty-state__btn';
        btn.innerHTML = '<span class="material-symbols-outlined">add</span> Insert Template';
        btn.addEventListener('click', () => this.#insertTemplate());
        el.appendChild(btn);

        return el;
    }

    async #insertTemplate() {
        // Remove empty state and mount Monaco with template
        const emptyState = this.#rootEl.querySelector('.module-file-editor__empty-state');
        if (emptyState) emptyState.remove();

        const editorContainer = document.createElement('div');
        editorContainer.className = 'module-file-editor__monaco';
        this.#rootEl.appendChild(editorContainer);

        await this.#mountMonaco(editorContainer, MODULE_TEMPLATE);
        this.#onChangeCallback?.();
    }

    // ─── Monaco ──────────────────────────────────────────────────────────────

    async #mountMonaco(editorContainer, body) {
        const factory = await getEditorFactory();
        this.#editorHandle = factory.createEditor(editorContainer, body, {
            readOnly: this.#readonly,
            noAutoHeight: true,
        });

        // Track content changes
        this.#contentDisposable = this.#editorHandle.onDidChange(() => {
            if (!this.#readonly) {
                this.#stripDirectives();
            }

            // Update badge on change (debounced via rAF)
            requestAnimationFrame(() => {
                this.#updateHeaderBadge();
            });

            this.#onChangeCallback?.();
        });
    }

    // ─── Directive blocking ──────────────────────────────────────────────────

    #stripDirectives() {
        const editor = this.#editorHandle?.editor;
        if (!editor) return;

        const model = editor.getModel();
        if (!model) return;

        const edits = [];
        const lineCount = model.getLineCount();

        for (let i = 1; i <= lineCount; i++) {
            const lineContent = model.getLineContent(i);
            if (DIRECTIVE_RE.test(lineContent.trim())) {
                edits.push({
                    range: {
                        startLineNumber: i,
                        startColumn: 1,
                        endLineNumber: i < lineCount ? i + 1 : i,
                        endColumn: i < lineCount ? 1 : lineContent.length + 1,
                    },
                    text: '',
                });
            }
        }

        if (edits.length > 0) {
            model.pushEditOperations([], edits, () => null);
        }
    }
}
