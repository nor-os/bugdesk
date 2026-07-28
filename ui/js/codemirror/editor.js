/**
 * EcolangEditor - Main CodeMirror Wrapper
 *
 * Provides a simple API for creating EcoLang editors with all features:
 * - Syntax highlighting
 * - Autocomplete
 * - Validation/linting
 * - Custom keybindings
 *
 * Replaces ExpressionField's internal implementation while maintaining
 * a similar external API.
 */

import { EditorState, Compartment } from '@codemirror/state';
import {
    EditorView,
    lineNumbers,
    drawSelection,
    highlightActiveLine,
    highlightSpecialChars,
    placeholder as placeholderExt,
} from '@codemirror/view';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { search } from '@codemirror/search';
import { keymap } from '@codemirror/view';

// Import EcoLang extensions
import { ecolangLanguage } from './language.js';
import { ecolangTheme } from './theme.js';
import {
    ecolangAutocomplete,
    allowedVariablesFacet,
    expressionServicesFacet,
    namespaceIdFacet,
    extraAllowedFacet,
    moduleImportsFacet,
    completionKeymap,
} from './autocomplete.js';
import { diagnosticCount, forEachDiagnostic } from '@codemirror/lint';
import {
    ecolangLint,
    allowDeclarationsFacet as lintAllowDeclarationsFacet,
    unknownAsWarningsFacet,
    reservedNamesFacet,
    restrictToAllowedFacet,
} from './linter.js';
import {
    ecolangKeymap,
    singleLineFacet,
    allowDeclarationsFacet as keymapAllowDeclarationsFacet,
    readonlyFacet,
    singleLineEnterHandler,
} from './keymap.js';
import { ecolangSignatureHelp } from './signature_help.js';

// ============================================================================
// EcolangEditor Class
// ============================================================================

/**
 * EcolangEditor - CodeMirror wrapper for EcoLang expressions
 *
 * @example
 * const editor = new EcolangEditor({
 *     parent: document.getElementById('editor-container'),
 *     value: 'x + y',
 *     singleLine: false,
 *     allowedVariables: ['x', 'y'],
 *     onChange: (value) => console.log('Changed:', value),
 * });
 */
export class EcolangEditor {
    /**
     * Create a new EcolangEditor instance
     *
     * @param {Object} options - Configuration options
     * @param {HTMLElement} options.parent - Container element to mount editor in
     * @param {string} [options.value=''] - Initial value
     * @param {boolean} [options.singleLine=false] - Single-line mode (no Enter key)
     * @param {boolean} [options.readonly=false] - Read-only mode
     * @param {string} [options.placeholder=''] - Placeholder text when empty
     * @param {boolean} [options.allowDeclarations=false] - Allow let/return declarations
     * @param {Array<string>} [options.allowedVariables=null] - Allowed variable names
     * @param {Array<string>} [options.extraAllowed=null] - Additional allowed names
     * @param {Array<Object>} [options.moduleImports=null] - Module imports for bare name access
     *        Format: [{ moduleName: 'Mod', functions: ['fn1'], aliases: { fn1: 'alias' } }]
     * @param {Object} [options.expressionServices=null] - ExpressionServices instance
     * @param {string} [options.namespaceId=null] - Current namespace ID
     * @param {boolean} [options.showLineNumbers=false] - Show line number gutter
     * @param {boolean} [options.unknownAsWarnings=true] - Treat unknown refs as warnings
     * @param {boolean} [options.restrictToAllowed=false] - Restrict to allowed names + builtins only
     * @param {Function} [options.onChange=null] - Called on content change
     * @param {Function} [options.onBlur=null] - Called on blur
     * @param {Function} [options.onFocus=null] - Called on focus
     * @param {Function} [options.onDiagnostics=null] - Called when lint diagnostics change: ({hasErrors, hasWarnings}) => void
     */
    constructor(options = {}) {
        const {
            parent,
            value = '',
            singleLine = false,
            readonly = false,
            placeholder = '',
            allowDeclarations = false,
            allowedVariables = null,
            extraAllowed = null,
            moduleImports = null,
            expressionServices = null,
            namespaceId = null,
            showLineNumbers = false,
            unknownAsWarnings = true,
            restrictToAllowed = false,
            reservedNames = null,
            onChange = null,
            onBlur = null,
            onFocus = null,
            onDiagnostics = null,
        } = options;

        // Store callbacks
        this._onChange = onChange;
        this._onBlur = onBlur;
        this._onFocus = onFocus;
        this._onDiagnostics = onDiagnostics;
        this._singleLine = singleLine;
        this._lastDiagHasErrors = false;
        this._lastDiagHasWarnings = false;

        // Create compartments for dynamic reconfiguration
        this._readonlyCompartment = new Compartment();
        this._allowedVarsCompartment = new Compartment();
        this._extraAllowedCompartment = new Compartment();
        this._moduleImportsCompartment = new Compartment();
        this._namespaceCompartment = new Compartment();

        // Get expression services from options or global
        const services = expressionServices ||
            window.__ECOSIM_JS_NEW__?.expressionServices ||
            null;

        // Build extensions
        const lint = options.lint !== false;

        const extensions = [
            // Core editing features
            history(),
            drawSelection(),
            highlightSpecialChars(),
            indentOnInput(),
            bracketMatching(),
            search({ top: true }),

            // EcoLang language support
            ecolangLanguage,

            // Theme
            ecolangTheme,

            // Autocomplete
            ecolangAutocomplete,

            // Function signature help (parameter hints)
            ecolangSignatureHelp,

            // Linting/validation (can be disabled for read-only views)
            ...(lint ? [ecolangLint] : []),

            // Custom keybindings
            ecolangKeymap,
            keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap]),

            // High-priority Enter handler for single-line mode
            // This runs before autocomplete intercepts Enter, ensuring blur/save triggers
            singleLineEnterHandler,

            // Configuration facets (static)
            singleLineFacet.of(singleLine),
            keymapAllowDeclarationsFacet.of(allowDeclarations),
            lintAllowDeclarationsFacet.of(allowDeclarations),
            unknownAsWarningsFacet.of(unknownAsWarnings),
            restrictToAllowedFacet.of(restrictToAllowed),
            expressionServicesFacet.of(services),
            reservedNamesFacet.of(reservedNames || []),

            // Configuration facets (dynamic - in compartments)
            this._readonlyCompartment.of([
                readonlyFacet.of(readonly),
                EditorState.readOnly.of(readonly),
            ]),
            // Pass allowedVariables as-is: null = no restriction, [] = restrict to nothing
            this._allowedVarsCompartment.of(allowedVariablesFacet.of(allowedVariables)),
            this._extraAllowedCompartment.of(extraAllowedFacet.of(extraAllowed || [])),
            this._moduleImportsCompartment.of(moduleImportsFacet.of(moduleImports || [])),
            this._namespaceCompartment.of(namespaceIdFacet.of(namespaceId)),

            // Change + diagnostics listener
            EditorView.updateListener.of((update) => {
                if (update.docChanged && this._onChange) {
                    this._onChange(update.state.doc.toString());
                }
                if (update.focusChanged) {
                    if (update.view.hasFocus && this._onFocus) {
                        this._onFocus();
                    } else if (!update.view.hasFocus && this._onBlur) {
                        this._onBlur(update.state.doc.toString());
                    }
                }
                // Notify parent of diagnostic state changes (for CSS class toggling)
                if (this._onDiagnostics) {
                    let hasErrors = false;
                    let hasWarnings = false;
                    forEachDiagnostic(update.state, (d) => {
                        if (d.severity === 'error') hasErrors = true;
                        else if (d.severity === 'warning') hasWarnings = true;
                    });
                    if (hasErrors !== this._lastDiagHasErrors || hasWarnings !== this._lastDiagHasWarnings) {
                        this._lastDiagHasErrors = hasErrors;
                        this._lastDiagHasWarnings = hasWarnings;
                        this._onDiagnostics({ hasErrors, hasWarnings });
                    }
                }
            }),

            // Placeholder
            placeholder ? placeholderExt(placeholder) : [],

            // Line numbers (optional)
            showLineNumbers ? lineNumbers() : [],
            showLineNumbers ? highlightActiveLine() : [],

            // Single-line styling
            singleLine ? EditorView.theme({
                '&': {
                    maxHeight: '24px',
                    minHeight: '20px',
                },
                '.cm-scroller': {
                    overflow: 'hidden !important',
                    lineHeight: '20px',
                },
                '.cm-content': {
                    whiteSpace: 'nowrap',
                    padding: '2px 4px',
                },
                '.cm-line': {
                    padding: '0',
                },
            }) : [],

            // Multiline styling (auto-resize friendly)
            !singleLine ? EditorView.theme({
                '.cm-scroller': {
                    overflow: 'auto',
                },
            }) : [],
        ];

        // Create the editor view - wrapped in stateGuard bypass if available
        // because CodeMirror sets data-* attributes internally
        const createEditor = () => {
            // Temporarily suppress the benign "Modifier function used at start of tag" warning
            // from CodeMirror's StreamLanguage token-to-tag mapping (e.g., 'function' -> tags.function(tags.variableName))
            const originalWarn = console.warn;
            console.warn = (...args) => {
                if (args[0]?.includes?.('Modifier function used at start of tag')) return;
                originalWarn.apply(console, args);
            };

            this.view = new EditorView({
                state: EditorState.create({
                    doc: value,
                    extensions,
                }),
                parent,
            });

            // Restore console.warn
            console.warn = originalWarn;

            // Add CSS classes for styling hooks
            this.view.dom.classList.add('ecolang-editor');
            if (singleLine) {
                this.view.dom.classList.add('cm-singleLine');
            }
            if (readonly) {
                this.view.dom.classList.add('cm-readonly');
            }
        };

        // Use stateGuard bypass if available to allow CodeMirror's internal DOM operations
        const stateGuard = window.stateGuard;
        if (stateGuard?.executeWithBypass) {
            stateGuard.executeWithBypass('EcolangEditor:create', createEditor);
        } else {
            createEditor();
        }
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Get the current editor content
     * @returns {string}
     */
    getValue() {
        return this.view.state.doc.toString();
    }

    /**
     * Set the editor content
     * @param {string} value - New content
     */
    setValue(value) {
        const currentValue = this.getValue();
        if (currentValue === value) return;

        this.view.dispatch({
            changes: {
                from: 0,
                to: this.view.state.doc.length,
                insert: value || '',
            },
        });
    }

    /**
     * Focus the editor
     */
    focus() {
        this.view.focus();
    }

    /**
     * Check if editor has focus
     * @returns {boolean}
     */
    hasFocus() {
        return this.view.hasFocus;
    }

    /**
     * Update allowed variables dynamically
     * @param {Array<string>|null} vars - New allowed variables (null = no restriction)
     */
    updateAllowedVariables(vars) {
        this.view.dispatch({
            effects: this._allowedVarsCompartment.reconfigure(
                allowedVariablesFacet.of(vars) // Pass as-is: null = no restriction
            ),
        });
    }

    /**
     * Update extra allowed names dynamically
     * @param {Array<string>} names - New extra allowed names
     */
    updateExtraAllowed(names) {
        this.view.dispatch({
            effects: this._extraAllowedCompartment.reconfigure(
                extraAllowedFacet.of(names || [])
            ),
        });
    }

    /**
     * Update module imports dynamically
     * @param {Array<Object>} imports - New module imports
     *        Format: [{ moduleName: 'Mod', functions: ['fn1'], aliases: { fn1: 'alias' } }]
     */
    updateModuleImports(imports) {
        this.view.dispatch({
            effects: this._moduleImportsCompartment.reconfigure(
                moduleImportsFacet.of(imports || [])
            ),
        });
    }

    /**
     * Update namespace ID dynamically
     * @param {string} namespaceId - New namespace ID
     */
    updateNamespaceId(namespaceId) {
        this.view.dispatch({
            effects: this._namespaceCompartment.reconfigure(
                namespaceIdFacet.of(namespaceId)
            ),
        });
    }

    /**
     * Set readonly state
     * @param {boolean} readonly - Whether editor should be readonly
     */
    setReadonly(readonly) {
        const doSetReadonly = () => {
            this.view.dispatch({
                effects: this._readonlyCompartment.reconfigure([
                    readonlyFacet.of(readonly),
                    EditorState.readOnly.of(readonly),
                ]),
            });
            this.view.dom.classList.toggle('cm-readonly', readonly);
        };

        const stateGuard = window.stateGuard;
        if (stateGuard?.executeWithBypass) {
            stateGuard.executeWithBypass('EcolangEditor:setReadonly', doSetReadonly);
        } else {
            doSetReadonly();
        }
    }

    /**
     * Get the DOM element
     * @returns {HTMLElement}
     */
    get dom() {
        return this.view.dom;
    }

    /**
     * Get the content element (for compatibility with old input-based code)
     * @returns {HTMLElement}
     */
    get contentDOM() {
        return this.view.contentDOM;
    }

    /**
     * Get current selection position
     * @returns {{from: number, to: number}}
     */
    getSelection() {
        const sel = this.view.state.selection.main;
        return { from: sel.from, to: sel.to };
    }

    /**
     * Set selection
     * @param {number} from - Start position
     * @param {number} [to] - End position (defaults to from)
     */
    setSelection(from, to = from) {
        this.view.dispatch({
            selection: { anchor: from, head: to },
        });
    }

    /**
     * Insert text at current position
     * @param {string} text - Text to insert
     */
    insert(text) {
        const pos = this.view.state.selection.main.head;
        this.view.dispatch({
            changes: { from: pos, insert: text },
            selection: { anchor: pos + text.length },
        });
    }

    /**
     * Destroy the editor and clean up
     */
    dispose() {
        this.view.destroy();
        this._onChange = null;
        this._onBlur = null;
        this._onFocus = null;
        this._onDiagnostics = null;
    }

    /**
     * Alias for dispose (for compatibility)
     */
    destroy() {
        this.dispose();
    }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a single-line expression editor (for node config panels)
 */
export function createSingleLineEditor(options) {
    return new EcolangEditor({
        ...options,
        singleLine: true,
        showLineNumbers: false,
    });
}

/**
 * Create a multiline function body editor (for functions page)
 */
export function createFunctionEditor(options) {
    return new EcolangEditor({
        ...options,
        singleLine: false,
        showLineNumbers: true,
        allowDeclarations: true,
    });
}

/**
 * Create a Godley table expression editor
 */
export function createGodleyEditor(options) {
    return new EcolangEditor({
        ...options,
        singleLine: true,
        showLineNumbers: false,
        allowDeclarations: false,
    });
}

/**
 * Create a full-document DSL editor (for the DSL editor window).
 * Multiline, line numbers, no variable restriction, unknowns as warnings.
 */
export function createDslEditor(options) {
    return new EcolangEditor({
        ...options,
        singleLine: false,
        showLineNumbers: true,
        allowDeclarations: true,
        unknownAsWarnings: true,
        allowedVariables: null,
    });
}

export default EcolangEditor;
