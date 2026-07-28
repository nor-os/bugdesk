/**
 * ExpressionField Component
 * Location: ui/components/expression_field.js
 *
 * Purpose: Provide a rich expression input with syntax highlighting, autocomplete,
 * and double-click modal support for EcoLang expressions.
 *
 * Features:
 * - Syntax highlighting via CodeMirror (EcolangEditor)
 * - Autocomplete via CodeMirror
 * - Live validation via the CodeMirror linter (single validation system)
 * - CSS class toggling driven by linter diagnostics (onDiagnostics callback)
 * - Double-click to open expression modal
 *
 * ============================================================================
 * ARCHITECTURE: allowedVariables Flow (DO NOT BREAK!)
 * ============================================================================
 *
 * This documents the critical flow of `allowedVariables` through the system.
 * Breaking this flow causes autocomplete to show variables that shouldn't be
 * available (e.g., showing all namespace variables in a differential node that
 * should only see connected inputs).
 *
 * DATA FLOW:
 * 1. Node Definition (e.g., differential_node.js) provides `allowedVariablesProvider`
 *    - Returns array of connected variable names, or null if not ready
 *    - Example: ['x', 'y'] for connected vars, null if connections not loaded
 *
 * 2. ExpressionField stores this provider and uses it in two places:
 *    a) _createEditor() - passes result to EcolangEditor for inline editing
 *    b) #openModal() - MUST pass provider to ExpressionModal (see below)
 *
 * 3. EcolangEditor receives allowedVariables and configures:
 *    - Autocomplete (via allowedVariablesFacet)
 *    - Validation (via linter)
 *
 * 4. ExpressionModal creates its OWN EcolangEditor, so it MUST receive:
 *    - allowedVariables (static value)
 *    - allowedVariablesProvider (dynamic function)
 *
 * INVARIANTS:
 * - When provider returns null -> convert to [] (restrict to builtins only)
 * - When provider returns [] -> restrict to builtins only
 * - When provider returns ['x','y'] -> restrict to those + builtins
 * - When allowedVariables is null (no provider) -> NO restriction (all vars allowed)
 *
 * PROHIBITIONS:
 * - NEVER hardcode allowedVariables: null in modal/editor when a provider exists
 * - NEVER skip passing allowedVariablesProvider to the modal
 * - NEVER use allowedVariables: null to mean "empty" - use [] instead
 *
 * TEST CASE:
 * 1. Create differential node with NO connections
 * 2. Open expression field (inline or modal)
 * 3. Autocomplete should ONLY show: builtins, constants, DSL keywords
 * 4. It should NOT show: namespace variables, other node outputs
 *
 * ============================================================================
 */

import { EcolangEditor } from '../../codemirror/editor.js';
import { ExpressionModal, getOpenModal, transferModalOwnership } from './expression_modal.js';

// DSL keywords that should not be treated as declared locals
const DSL_KEYWORDS = new Set(['match', 'f_smooth', 'end', 'lambda', 'beta', '_', 'return', 'let']);

export class ExpressionField {
    // Data manager reference for namespace lookups
    #dataManager = null;
    // Symbol registry for builtins and autocomplete
    #symbolRegistry = null;

    constructor({ fieldId, field, namespaceId = null, expressionServices = null, logger = null, onChange = null } = {}) {
        if (!fieldId) {
            throw new Error('ExpressionField requires a fieldId');
        }
        this.fieldId = fieldId;
        this.field = field ?? {};
        this.namespaceId = namespaceId;
        this.expressionServices = expressionServices;
        this.logger = logger;
        this.onChange = typeof onChange === 'function' ? onChange : null;
        this.emitOnInput = Boolean(this.field.emitOnInput ?? this.field.emitsOnInput);
        this.disabled = Boolean(this.field.disabled);

        // Get data manager reference for namespace lookups
        this.#dataManager = window.__ECOSIM_JS_NEW__?.dataManager || null;
        // Get symbol registry for builtins (synced from backend)
        this.#symbolRegistry = window.__ECOSIM_JS_NEW__?.symbolRegistry || null;

        // Expression settings from descriptor
        const exprSettings = this.field.expression ?? {};
        this.enableHighlighting = exprSettings.enableHighlighting !== false;
        this.enableAutocomplete = exprSettings.enableAutocomplete !== false;
        this.language = exprSettings.language ?? 'ecolang';
        this.multiline = Boolean(exprSettings.multiline);
        this.allowDeclarations = Boolean(exprSettings.allowDeclarations);
        this.unknownAsWarnings = Boolean(exprSettings.unknownAsWarnings);
        this.extraAllowed = Array.isArray(exprSettings.extraAllowed) ? exprSettings.extraAllowed : null;
        this.moduleImports = Array.isArray(exprSettings.moduleImports) ? exprSettings.moduleImports : null;
        this.reservedNamesAdditional = Array.isArray(exprSettings.reservedNamesAdditional)
            ? exprSettings.reservedNamesAdditional
            : null;
        this.allowedVariablesProvider = typeof exprSettings.allowedVariablesProvider === 'function'
            ? exprSettings.allowedVariablesProvider
            : null;
        // When set, autocomplete only suggests these variable names (+ builtins)
        // Used for function mode where only named inputs should be suggested
        this.allowedVariables = Array.isArray(exprSettings.allowedVariables) ? exprSettings.allowedVariables : null;

        /**
         * searchScope controls how cross-namespace variables are handled:
         * - 'local': Only show variables from current namespace (default for Godley tables)
         * - 'global': Show all variables from all namespaces (unqualified)
         * - 'qualified-only': Show local unqualified + namespace prefixes for cross-namespace access
         */
        this.searchScope = exprSettings.searchScope ?? 'local';
        this.disableModal = Boolean(exprSettings.disableModal);

        this.root = null;
        this.input = null; // For backward compatibility - points to editor DOM
        this.helperEl = null;
        this._disposers = [];
        this._modalHandle = null;
        this._editor = null; // EcolangEditor instance
        this._lastEmittedValue = '';
    }

    render() {
        if (this.root) {
            return this.root;
        }
        this.root = document.createElement('div');
        this.root.className = 'expression-field';
        if (this.multiline) {
            this.root.classList.add('expression-field--multiline');
        }
        // Apply custom className from field descriptor (e.g., 'expression-field--compact')
        if (this.field.className) {
            this.field.className.split(/\s+/).filter(Boolean).forEach((cls) => {
                this.root.classList.add(cls);
            });
        }

        // Normalize initial value
        let initialValue = String(this.field.value ?? '');
        if (!this.multiline) {
            initialValue = initialValue.replace(/[\r\n]+/g, ' ').trim();
        }

        // Create editor container
        const editorContainer = document.createElement('div');
        editorContainer.className = 'expression-field__editor-container';
        if (this.disabled) {
            this.root.classList.add('expression-field--disabled');
        }

        // Helper text element
        this.helperEl = document.createElement('div');
        this.helperEl.className = 'expression-field__helper';
        if (this.field.helperText) {
            this.helperEl.textContent = this.field.helperText;
        }

        // Assemble DOM
        this.root.appendChild(editorContainer);
        this.root.appendChild(this.helperEl);

        // Create CodeMirror editor
        this._createEditor(editorContainer, initialValue);

        // Set up double-click modal (if enabled)
        this.#attachDoubleClickModal();

        // Check for existing open modal (survives panel re-renders)
        this.#reconnectToExistingModal(initialValue);

        this._lastEmittedValue = initialValue;

        return this.root;
    }

    /**
     * Check if there's an existing modal open for this field and reconnect to it.
     * This allows modals to stay open across panel re-renders (e.g., when connections change).
     */
    #reconnectToExistingModal(currentValue) {
        const existingModal = getOpenModal(this.fieldId);
        if (!existingModal) return;

        // Transfer callback ownership to this new field instance
        const reconnectedModal = transferModalOwnership(this.fieldId, {
            onChange: (value, ctx) => {
                // Update the main editor with modal changes
                if (this.getValue() !== value) {
                    this.setValue(value);
                }
            },
            onAutoSave: (value) => {
                // Autosave: persist to node config after 1 second of inactivity
                if (this.getValue() !== value) {
                    this.setValue(value);
                }
                this.onChange?.(value, { immediate: false });
            },
            onClose: (value) => {
                // Only update the inline editor if it still exists (field not disposed)
                // Note: onChange is NOT called here because autosave already handles persistence
                if (this._editor && this.getValue() !== value) {
                    this.setValue(value);
                }
                this._modalHandle = null;
            },
        });

        // Store reference to the existing modal
        this._modalHandle = reconnectedModal || existingModal;

        // Sync the modal's value if it differs from current field value
        const modalValue = existingModal.getValue?.();
        if (modalValue != null && modalValue !== currentValue) {
            // Modal has a different value - use modal's value as source of truth
            this.setValue(modalValue);
        }
    }

    /**
     * Create the EcolangEditor instance
     */
    _createEditor(container, initialValue) {
        const allowedVars = this.#currentAllowedVariables();
        const hasProvider = this.allowedVariablesProvider != null;

        this._editor = new EcolangEditor({
            parent: container,
            value: initialValue,
            singleLine: !this.multiline,
            readonly: this.disabled,
            placeholder: this.field.placeholder || '',
            allowDeclarations: this.allowDeclarations,
            allowedVariables: allowedVars,
            extraAllowed: this.extraAllowed,
            moduleImports: this.moduleImports,
            expressionServices: this.expressionServices,
            namespaceId: this.namespaceId,
            showLineNumbers: false, // Only function page uses line numbers
            unknownAsWarnings: this.unknownAsWarnings,
            restrictToAllowed: hasProvider,
            reservedNames: this.reservedNamesAdditional,
            onChange: (value) => {
                if (this.emitOnInput) {
                    this.onChange?.(value, { immediate: true });
                    this._lastEmittedValue = value;
                }
            },
            onBlur: (value) => {
                // Always trigger save on blur (commit the value)
                // This ensures Enter key and unfocus always persist changes
                this.onChange?.(value, { immediate: false });
                this._lastEmittedValue = value;
            },
            onDiagnostics: ({ hasErrors, hasWarnings }) => {
                if (!this.root) return;
                this.root.classList.toggle('expression-field--invalid', hasErrors);
                this.root.classList.toggle('expression-field--warning', hasWarnings && !hasErrors);
            },
        });

        // For backward compatibility, expose the editor DOM as 'input'
        this.input = this._editor.dom;

        // Update allowed variables when editor is focused (ensures autocomplete is current)
        if (this.allowedVariablesProvider && this._editor.dom) {
            this._editor.dom.addEventListener('focusin', () => {
                const allowedVars = this.#currentAllowedVariables();
                if (this._editor?.updateAllowedVariables) {
                    this._editor.updateAllowedVariables(allowedVars);
                }
            });
        }
    }

    dispose() {
        // Don't close the modal on dispose - it may be a panel re-render.
        // The modal uses a stable windowId (fieldId), so a new expression field
        // with the same fieldId will reconnect to it.
        // Just clear our reference without closing the actual modal window.
        this._modalHandle = null;

        // Destroy CodeMirror editor
        if (this._editor) {
            try {
                this._editor.dispose();
            } catch (_) {}
            this._editor = null;
        }

        this._disposers.forEach((dispose) => {
            try {
                dispose?.();
            } catch (error) {
                this.logger?.warn?.('expression-field', 'Failed to dispose listener', { error });
            }
        });
        this._disposers = [];
        this.root = null;
        this.input = null;
        this.helperEl = null;
    }

    getValue() {
        return this._editor?.getValue() ?? '';
    }

    setValue(value) {
        if (this._editor) {
            let normalized = value ?? '';
            // Strip newlines for single-line input
            if (!this.multiline && typeof normalized === 'string') {
                normalized = normalized.replace(/[\r\n]+/g, ' ').trim();
            }
            this._editor.setValue(normalized);
        }
    }

    /**
     * Focus the editor
     */
    focus() {
        this._editor?.focus();
    }

    /**
     * Update allowed variables dynamically
     * Used by functions page when parameters change
     */
    updateAllowedVariables(vars) {
        this._editor?.updateAllowedVariables(vars);
    }

    /**
     * Update namespace ID dynamically
     */
    updateNamespaceId(namespaceId) {
        this.namespaceId = namespaceId;
        this._editor?.updateNamespaceId(namespaceId);
    }

    #attachDoubleClickModal() {
        if (this.disabled || this.disableModal) {
            return;
        }
        const onDblClick = (event) => {
            // Only trigger on double-click within the editor
            if (!this._editor?.dom.contains(event.target)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            this.#openModal();
        };
        this._editor?.dom.addEventListener('dblclick', onDblClick);
        this._disposers.push(() => this._editor?.dom.removeEventListener('dblclick', onDblClick));
    }

    #openModal() {
        this.#closeModal('replaced');

        const displayLabel = this.field.label ?? 'Expression';
        // Resolve namespace name - namespaceId may be a UUID, so look up the actual name
        const namespaceName = this.#resolveNamespaceName(this.namespaceId);
        const subtitle = namespaceName ? `Namespace: ${namespaceName}` : '';

        // Create a temporary input to pass to the modal (for origin sync)
        const tempInput = document.createElement('input');
        tempInput.value = this.getValue();

        this._modalHandle = ExpressionModal.open({
            // Use fieldId as stable window ID so modal persists across panel re-renders
            windowId: this.fieldId,
            originInput: tempInput,
            namespace: this.namespaceId,
            initialValue: this.getValue(),
            title: `Edit Expression - ${displayLabel}`,
            subtitle,
            preventMultiline: !this.multiline,
            autocompleteProvider: this.#buildAutocompleteProvider(),
            // CRITICAL: Pass allowedVariables to modal to maintain autocomplete/validation restrictions
            // The modal creates its own EcolangEditor, so it needs these to enforce the same rules
            allowedVariables: this.allowedVariables,
            allowedVariablesProvider: this.allowedVariablesProvider,
            onChange: (value, ctx) => {
                // Update the main editor with modal changes
                if (this.getValue() !== value) {
                    this.setValue(value);
                }
            },
            onAutoSave: (value) => {
                // Autosave: persist to node config after 1 second of inactivity
                if (this.getValue() !== value) {
                    this.setValue(value);
                }
                this.onChange?.(value, { immediate: false });
            },
            onClose: (value) => {
                // Only update the inline editor if it still exists (field not disposed)
                // Note: onChange is NOT called here because autosave already handles persistence
                if (this._editor && this.getValue() !== value) {
                    this.setValue(value);
                }
                this._modalHandle = null;
            },
        });
    }

    #closeModal(reason) {
        if (this._modalHandle?.close) {
            try {
                this._modalHandle.close(reason);
            } catch (_) {}
        }
        this._modalHandle = null;
    }

    #buildAutocompleteProvider() {
        // Build autocomplete provider for modal (uses same logic as editor)
        return (ctx) => this.#getAutocompleteItems(ctx);
    }

    /**
     * Get autocomplete items based on context and searchScope configuration
     * Note: For CodeMirror editor, items are provided via facets.
     * This method is primarily for the modal which still uses custom autocomplete.
     */
    #getAutocompleteItems(ctx = {}) {
        const items = [];
        const seen = new Set();
        const allowedVariables = this.#currentAllowedVariables();
        const qualifiedPrefix = ctx.qualifiedPrefix || '';

        // Parse namespace prefix from qualified input (e.g., "Main.op" -> targetNs = "Main")
        const { targetNamespaceId, namespacePrefix } = this.#parseNamespacePrefix(qualifiedPrefix);

        // Collect declared locals when allowedDeclarations is enabled
        const declaredLocals = this.#collectDeclaredLocals(allowedVariables);

        // If allowedVariables is set, only suggest those variables (used in function mode)
        if (allowedVariables !== null) {
            return this.#buildRestrictedModeItems(allowedVariables, declaredLocals);
        }

        // Build items based on searchScope and namespace context
        const isCrossNamespaceQuery = targetNamespaceId && targetNamespaceId !== this.namespaceId;
        const fetchFromNamespace = targetNamespaceId || this.namespaceId;

        // Get variable entries from expressionServices
        if (this.expressionServices) {
            try {
                const entries = this.#buildEntriesFromExpressionServices({
                    fetchFromNamespace,
                    isCrossNamespaceQuery,
                    namespacePrefix,
                });

                entries.forEach((entry) => {
                    const key = `${entry.type}:${entry.label}`;
                    if (seen.has(key)) return;
                    seen.add(key);
                    items.push(entry);
                });
            } catch (error) {
                this.logger?.warn?.('expression-field', 'Failed to build autocomplete entries', { error });
            }
        }

        // Add declared locals (variables declared in the current expression)
        declaredLocals.forEach((name) => {
            const key = `var:${name}`;
            if (seen.has(key)) return;
            seen.add(key);
            items.push({
                label: name,
                insertText: name,
                type: 'var',
                description: 'Local variable',
                iconType: 'variable',
            });
        });

        // Add built-in constants, functions, module functions, namespaces, and keywords (only for local queries)
        if (!isCrossNamespaceQuery) {
            this.#addBuiltinConstants(items, seen);
            this.#addBuiltinFunctions(items, seen);
            this.#addModuleFunctions(items, seen);
            this.#addNamespaces(items, seen);
            this.#addDslKeywords(items, seen);
        }

        return items;
    }

    /**
     * Parse namespace prefix from qualified input
     */
    #parseNamespacePrefix(qualifiedPrefix) {
        let targetNamespaceId = null;
        let namespacePrefix = '';

        const dotIdx = qualifiedPrefix.indexOf('.');
        if (dotIdx > 0) {
            namespacePrefix = qualifiedPrefix.substring(0, dotIdx);

            // Look up namespace by name/token to get its ID
            if (this.#dataManager?.listNamespaces) {
                const namespaces = this.#dataManager.listNamespaces() || [];
                const matchedNs = namespaces.find(ns =>
                    (ns.displayName || ns.slug || ns.id) === namespacePrefix
                );
                if (matchedNs) {
                    targetNamespaceId = matchedNs.id;
                }
            }
        }

        return { targetNamespaceId, namespacePrefix };
    }

    /**
     * Collect declared local variables from current expression
     */
    #collectDeclaredLocals(allowedVariables) {
        const declaredLocals = new Set();
        if (this.allowDeclarations && this.expressionServices) {
            try {
                const validation = this.expressionServices.validate(this.getValue(), {
                    namespaceId: this.namespaceId,
                    includeCrossNamespace: true,
                    allowDeclarations: true,
                    unknownAsWarnings: true,
                    allowedNames: allowedVariables,
                    extraAllowed: this.extraAllowed,
                    reservedNamesAdditional: this.reservedNamesAdditional,
                    includeAllowedSnapshot: true,
                });
                const allowedNames = validation?.allowedNames || [];
                const baseAllowed = new Set(allowedVariables || []);

                // Collect built-in function and constant names to exclude from declared locals
                const builtinNames = this.#symbolRegistry?.getReservedNames?.() ?? new Set();

                // Collect module names and module function names to exclude
                const moduleNames = new Set();
                if (this.expressionServices?.moduleRegistry) {
                    const moduleRegistry = this.expressionServices.moduleRegistry;
                    const allModules = moduleRegistry.getAllModules?.() || new Map();
                    for (const [moduleName, mod] of allModules) {
                        moduleNames.add(moduleName);
                        const exported = moduleRegistry.getExportedFunctions?.(moduleName) || {};
                        for (const funcName of Object.keys(exported)) {
                            moduleNames.add(`${moduleName}.${funcName}`);
                        }
                    }
                }

                // Collect namespace names to exclude
                const namespaceNames = new Set();
                const dataManager = this.#dataManager || this.expressionServices?.symbols?.dataManager;
                if (dataManager?.listNamespaces) {
                    const namespaces = dataManager.listNamespaces() || [];
                    for (const ns of namespaces) {
                        const token = ns.displayName || ns.slug || ns.id?.slice(0, 8);
                        if (token) namespaceNames.add(token);
                    }
                }

                allowedNames.forEach((name) => {
                    // Only add to declared locals if not in base allowed, not a built-in,
                    // not a DSL keyword, not a module/function name, and not a namespace
                    if (!baseAllowed.has(name) && !builtinNames.has(name) &&
                        !DSL_KEYWORDS.has(name) && !moduleNames.has(name) && !namespaceNames.has(name)) {
                        declaredLocals.add(name);
                    }
                });
            } catch (error) {
                this.logger?.debug?.('expression-field', 'Failed to collect declared locals', { error });
            }
        }
        return declaredLocals;
    }

    /**
     * Build items for restricted mode (function expressions with allowedVariables)
     */
    #buildRestrictedModeItems(allowedVariables, declaredLocals) {
        const items = [];
        allowedVariables.forEach((varName) => {
            items.push({
                label: varName,
                insertText: varName,
                type: 'var',
                description: 'Named input parameter',
                iconType: 'variable',
            });
        });
        declaredLocals.forEach((name) => {
            items.push({
                label: name,
                insertText: name,
                type: 'var',
                description: 'Local variable',
                iconType: 'variable',
            });
        });
        this.#addBuiltinConstants(items, new Set());
        this.#addBuiltinFunctions(items, new Set());
        this.#addModuleFunctions(items, new Set());
        this.#addNamespaces(items, new Set());
        this.#addDslKeywords(items, new Set());
        return items;
    }

    /**
     * Add namespaces to items array (from dataManager)
     */
    #addNamespaces(items, seen) {
        const dataManager = this.#dataManager || this.expressionServices?.symbols?.dataManager;
        if (!dataManager?.listNamespaces) return;

        try {
            const namespaces = dataManager.listNamespaces() || [];
            for (const ns of namespaces) {
                const token = ns.displayName || ns.slug || ns.id?.slice(0, 8);
                if (!token) continue;
                const key = `namespace:${token}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({
                    label: `${token}.`,
                    insertText: `${token}.`,
                    type: 'namespace',
                    description: 'namespace',
                    iconType: 'namespace',
                });
            }
        } catch (_) { /* ignore */ }
    }

    /**
     * Add module functions to items array (from expressionServices/moduleRegistry)
     */
    #addModuleFunctions(items, seen) {
        if (this.expressionServices?.moduleRegistry) {
            try {
                const moduleRegistry = this.expressionServices.moduleRegistry;
                const allModules = moduleRegistry.getAllModules?.() || new Map();
                for (const [moduleName, mod] of allModules) {
                    const exported = moduleRegistry.getExportedFunctions?.(moduleName) || {};
                    for (const [funcName, fn] of Object.entries(exported)) {
                        const qualifiedName = `${moduleName}.${funcName}`;
                        const key = `fn:${qualifiedName}`;
                        if (seen.has(key)) continue;
                        seen.add(key);

                        const sourceLabel = mod.source === 'builtin' ? 'builtin' :
                                          mod.source === 'addon' ? 'addon' : 'project';
                        const desc = fn.description || `${sourceLabel} function from ${moduleName}`;

                        items.push({
                            label: `${qualifiedName}(`,
                            insertText: `${qualifiedName}(`,
                            type: 'fn',
                            signature: fn.signature ?? `${funcName}(${(fn.params || []).join(', ')})`,
                            description: desc,
                            iconType: 'function',
                        });
                    }
                }
            } catch (_) { /* ignore */ }
        }
    }

    /**
     * Add DSL keywords to items array
     */
    #addDslKeywords(items, seen) {
        DSL_KEYWORDS.forEach((keyword) => {
            const key = `keyword:${keyword}`;
            if (seen.has(key)) return;
            seen.add(key);
            items.push({
                label: keyword,
                insertText: keyword,
                type: 'keyword',
                description: 'keyword',
                iconType: 'keyword',
            });
        });
    }

    /**
     * Build autocomplete entries from ExpressionServices with namespace awareness
     */
    #buildEntriesFromExpressionServices({ fetchFromNamespace, isCrossNamespaceQuery, namespacePrefix }) {
        const items = [];

        let includeCrossNamespace = false;
        let includeNamespaces = false;

        switch (this.searchScope) {
            case 'global':
                includeCrossNamespace = true;
                includeNamespaces = false;
                break;
            case 'qualified-only':
            case 'local':
            default:
                includeCrossNamespace = false;
                includeNamespaces = !isCrossNamespaceQuery;
                break;
        }

        const entries = this.expressionServices.buildAutocompleteEntries({
            namespaceId: fetchFromNamespace,
            includeCrossNamespace: includeCrossNamespace && !isCrossNamespaceQuery,
            includeDisplayNames: true,
            includeStocks: true,
            includeOperators: !isCrossNamespaceQuery,
            includeSnippets: !isCrossNamespaceQuery,
            includeConstants: !isCrossNamespaceQuery,
            includeNamespaces,
        }) || [];

        entries.forEach((entry) => {
            let label = entry.label;
            let insertText = entry.insertText || entry.label;
            let detail = entry.description || entry.detail;

            if (isCrossNamespaceQuery && (entry.type === 'variable' || entry.type === 'stock')) {
                label = `${namespacePrefix}.${entry.label}`;
                insertText = `${namespacePrefix}.${entry.insertText || entry.label}`;
                detail = detail || `from ${namespacePrefix}`;
            }

            items.push({
                label,
                insertText,
                type: entry.type || 'var',
                signature: entry.signature ?? '',
                description: detail ?? '',
                iconType: entry.iconType ?? 'variable',
            });
        });

        return items;
    }

    /**
     * Add built-in constants to items array
     */
    #addBuiltinConstants(items, seen) {
        try {
            const constants = this.#symbolRegistry?.getBuiltinConstants?.() ?? [];
            constants.forEach((c) => {
                const key = `constant:${c.name}`;
                if (seen.has(key)) return;
                seen.add(key);
                const desc = c.description || '';
                const valueStr = c.value != null
                    ? ` ≈ ${typeof c.value.toFixed === 'function' ? c.value.toFixed(5) : c.value}`
                    : '';
                items.push({
                    label: c.name,
                    type: 'var',
                    description: desc + valueStr,
                    meta: 'constant',
                    iconType: 'constant',
                });
            });
        } catch (_) { /* ignore */ }
    }

    /**
     * Add built-in functions to items array
     */
    #addBuiltinFunctions(items, seen) {
        try {
            const funcs = this.#symbolRegistry?.getBuiltinFunctions?.() ?? [];
            funcs.forEach((fn) => {
                const key = `fn:${fn.name}`;
                if (seen.has(key)) return;
                seen.add(key);
                items.push({
                    label: `${fn.name}(`,
                    insertText: `${fn.name}(`,
                    type: 'fn',
                    signature: fn.signature ?? '',
                    description: fn.description ?? '',
                    iconType: 'function',
                });
            });
        } catch (_) { /* ignore */ }
    }

    #currentAllowedVariables() {
        if (this.allowedVariablesProvider) {
            try {
                const value = this.allowedVariablesProvider();
                if (Array.isArray(value)) {
                    return value.filter(Boolean);
                }
                // Provider returned null (connections not loaded yet).
                // For autocomplete, return empty array to restrict to builtins only.
                // This prevents suggesting variables that aren't connected.
                return [];
            } catch (error) {
                this.logger?.debug?.('expression-field', 'allowedVariablesProvider failed', { error });
                // On error, restrict to builtins only
                return [];
            }
        }
        return this.allowedVariables;
    }

    /**
     * Resolve namespace ID to a human-readable name.
     */
    #resolveNamespaceName(namespaceId) {
        if (!namespaceId) {
            return null;
        }
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(namespaceId);

        if (!isUuid) {
            return namespaceId;
        }

        // Try uiManager tabs
        try {
            if (window.uiManager?.tabs) {
                const tab = window.uiManager.tabs.find((t) => t.id === namespaceId);
                if (tab?.name) {
                    return tab.name;
                }
            }
        } catch (_) {}

        // Try expressionServices
        try {
            if (this.expressionServices?.resolveNamespaceName) {
                const name = this.expressionServices.resolveNamespaceName(namespaceId);
                if (name) {
                    return name;
                }
            }
        } catch (_) {}

        // Try dataManager
        try {
            const dataManager = this.#dataManager || window.__ECOSIM_JS_NEW__?.dataManager;
            if (dataManager?.listNamespaces) {
                const namespaces = dataManager.listNamespaces() || [];
                const ns = namespaces.find((n) => n.id === namespaceId);
                if (ns) {
                    return ns.displayName || ns.slug || ns.name || ns.token;
                }
            }
        } catch (_) {}

        return namespaceId.slice(0, 8) + '...';
    }
}
