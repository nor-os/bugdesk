/**
 * Expression Modal Component
 * Location: ui/components/expression_modal.js
 *
 * Purpose: Provide a modal editor for editing expressions with full-size editor,
 * syntax highlighting, and autocomplete support.
 *
 * Features:
 * - Draggable, resizable window for expression editing
 * - Multiple simultaneous windows for different expressions
 * - Minimize to taskbar, maximize support
 * - Position/size persistence across sessions
 * - Syncs with origin input field
 * - Keyboard shortcuts (Escape to close, Ctrl+Enter to submit)
 * - Autosave after 1 second of inactivity with "Saved" indicator
 *
 * ============================================================================
 * CRITICAL: allowedVariables Architecture
 * ============================================================================
 *
 * This modal creates its OWN EcolangEditor instance. It MUST receive the same
 * allowedVariables/allowedVariablesProvider as the parent ExpressionField,
 * otherwise autocomplete will show incorrect variables.
 *
 * REQUIRED OPTIONS:
 * - allowedVariables: Static array of allowed variable names, or null for no restriction
 * - allowedVariablesProvider: Function that returns current allowed variables dynamically
 *
 * PROHIBITION:
 * - NEVER use allowedVariables: null when a provider exists
 * - The modal's editor MUST use the same restrictions as the inline editor
 *
 * See expression_field.js for full architecture documentation.
 * ============================================================================
 */

import { EcolangEditor } from '../../codemirror/editor.js';
import { ManagedWindow } from './managed_window.js';

// Track all open expression windows by their unique ID
const openWindows = new Map(); // id -> { window, modal, originInput }

// Counter for generating unique window IDs
let windowIdCounter = 0;

/**
 * Generate a unique window ID for an expression.
 * Uses explicit windowId if provided, then originInput's stored ID, otherwise generates a new ID.
 * @param {HTMLElement|null} originInput - The origin input element
 * @param {string|null} explicitId - Explicit window ID to use (e.g., fieldId)
 */
function getWindowId(originInput, explicitId = null) {
    // Use explicit ID if provided (stable across field re-renders)
    if (explicitId) {
        return `expression-editor-${explicitId}`;
    }
    if (originInput && originInput._expressionWindowId) {
        return originInput._expressionWindowId;
    }
    const id = `expression-editor-${++windowIdCounter}`;
    if (originInput) {
        originInput._expressionWindowId = id;
    }
    return id;
}

/**
 * Check if there's an open modal for the given window ID.
 * @param {string} windowId - The window ID to check
 * @returns {Object|null} The modal handle if found, null otherwise
 */
export function getOpenModal(windowId) {
    const fullId = windowId.startsWith('expression-editor-') ? windowId : `expression-editor-${windowId}`;
    const entry = openWindows.get(fullId);
    return entry?.modal || null;
}

/**
 * Transfer ownership of a modal to a new handler.
 * Used when an expression field is recreated but the modal should stay open.
 * @param {string} windowId - The window ID
 * @param {Object} newCallbacks - New callbacks { onChange, onClose }
 * @returns {Object|null} The modal handle if found and transferred
 */
export function transferModalOwnership(windowId, newCallbacks = {}) {
    const fullId = windowId.startsWith('expression-editor-') ? windowId : `expression-editor-${windowId}`;
    const entry = openWindows.get(fullId);
    if (!entry?.modal) return null;

    // Update callbacks in entry.callbacks (used by invokeCallback and close)
    if (!entry.callbacks) {
        entry.callbacks = {};
    }
    if (newCallbacks.onChange) {
        entry.callbacks.onChange = newCallbacks.onChange;
    }
    if (newCallbacks.onClose) {
        entry.callbacks.onClose = newCallbacks.onClose;
    }
    if (newCallbacks.onAutoSave) {
        entry.callbacks.onAutoSave = newCallbacks.onAutoSave;
    }

    return entry.modal;
}

/**
 * Close any currently active modal.
 * @param {string} reason - Reason for closing
 */
export function closeActiveModal(reason) {
    // Close all open windows
    for (const [id, entry] of openWindows) {
        if (entry.modal?.close) {
            try {
                entry.modal.close(reason || 'external');
            } catch (_) {}
        }
    }
}

/**
 * Open an expression modal.
 * @param {Object} options - Modal options
 * @param {HTMLInputElement|HTMLTextAreaElement} options.originInput - The input to sync with
 * @param {string} options.initialValue - Initial expression value
 * @param {string} options.namespace - Namespace for autocomplete context
 * @param {string} options.title - Modal title
 * @param {string} options.subtitle - Modal subtitle
 * @param {string} options.placeholder - Editor placeholder
 * @param {boolean} options.syncOrigin - Whether to sync with origin input (default: true)
 * @param {boolean} options.closeOnBackdrop - Whether to close on backdrop click (default: true)
 * @param {boolean} options.preventMultiline - Prevent Enter from creating newlines (default: true)
 * @param {Function} options.autocompleteProvider - Provider function for autocomplete (legacy, not used in CodeMirror mode)
 * @param {Object} options.expressionServices - ExpressionServices instance for autocomplete
 * @param {Function} options.onOpen - Called when modal opens
 * @param {Function} options.onChange - Called when value changes
 * @param {Function} options.onClose - Called when modal closes
 * @param {Function} options.onSubmit - Called on Ctrl+Enter/Ctrl+S
 * @param {string} options.windowId - Explicit window ID for stable identification across re-renders
 * @returns {Object} Modal handle with close, getValue, setValue methods
 */
export function openExpressionModal(options = {}) {
    const originInput = options.originInput || null;
    const windowId = getWindowId(originInput, options.windowId);

    // Check if window already exists for this expression
    const existingEntry = openWindows.get(windowId);
    if (existingEntry && existingEntry.window) {
        // Window exists - restore if minimized, or bring to front
        if (existingEntry.window.isMinimized) {
            ManagedWindow.restore(windowId);
        } else if (existingEntry.window.isVisible) {
            existingEntry.window.bringToFront();
        } else {
            existingEntry.window.show();
        }
        return existingEntry.modal;
    }

    const initialValue = options.initialValue != null
        ? String(options.initialValue)
        : originInput?.value ?? '';
    const namespace = options.namespace || null;
    const titleText = options.title || 'Edit Expression';
    const subtitleText = options.subtitle || '';
    const syncOrigin = options.syncOrigin !== false;
    const preventMultiline = options.preventMultiline !== false;
    const expressionServices = options.expressionServices ||
        window.__ECOSIM_JS_NEW__?.expressionServices || null;

    // Create content container for ManagedWindow
    const contentEl = document.createElement('div');
    contentEl.className = 'expression-modal__window-content';

    // Add subtitle if present
    if (subtitleText) {
        const meta = document.createElement('div');
        meta.className = 'expression-modal__meta';
        meta.textContent = subtitleText;
        contentEl.appendChild(meta);
    }

    // Create editor container
    const editorContainer = document.createElement('div');
    editorContainer.className = 'expression-modal__editor-container';
    contentEl.appendChild(editorContainer);

    // Create "Saved" indicator (hidden by default)
    const savedIndicator = document.createElement('div');
    savedIndicator.className = 'expression-modal__saved-indicator';
    savedIndicator.textContent = 'Saved';
    contentEl.appendChild(savedIndicator);

    // Close window via ManagedWindow - track if we initiated close
    let windowClosePending = false;

    // Current close function reference (updated below)
    let closeRef = null;

    // Create new ManagedWindow for this expression
    const expressionWindow = new ManagedWindow({
        id: windowId,
        title: titleText,
        icon: 'function',
        content: contentEl,
        minWidth: 500,
        minHeight: 300,
        defaultWidth: 600,
        defaultHeight: 400,
        canMaximize: true,
        modal: false, // No backdrop - expression editor should not blur content
        onClose: () => {
            if (!windowClosePending && closeRef) {
                windowClosePending = true;
                closeRef('window-close');
            }
        },
    });

    expressionWindow.show();

    let closed = false;
    let lastValue = initialValue;
    let lastSavedValue = initialValue; // Track what was last saved to config
    let finalValueOnClose = null; // Stores value when modal closes (for getValue after editor disposal)
    const listeners = [];
    let cmEditor = null;
    let autosaveTimer = null;
    let savedIndicatorTimer = null;

    // Show the "Saved" indicator briefly
    function showSavedIndicator() {
        if (closed) return;
        savedIndicator.classList.add('expression-modal__saved-indicator--visible');
        // Clear any existing timer
        if (savedIndicatorTimer) {
            clearTimeout(savedIndicatorTimer);
        }
        // Hide after 1 second
        savedIndicatorTimer = setTimeout(() => {
            savedIndicator.classList.remove('expression-modal__saved-indicator--visible');
            savedIndicatorTimer = null;
        }, 1000);
    }

    // Perform autosave - persist to node config
    function doAutosave() {
        if (closed) return;
        const currentValue = cmEditor?.getValue() ?? lastValue;
        // Only save if value changed since last save
        if (currentValue === lastSavedValue) return;

        lastSavedValue = currentValue;
        // Use entry's callback (may be updated by transferModalOwnership)
        const autoSaveCallback = openWindows.get(windowId)?.callbacks?.onAutoSave ?? options.onAutoSave;
        if (typeof autoSaveCallback === 'function') {
            try {
                autoSaveCallback(currentValue, context, 'autosave');
            } catch (_) {}
        }
        showSavedIndicator();
    }

    // Schedule autosave after 1 second of inactivity
    function scheduleAutosave() {
        if (closed) return;
        // Clear any existing timer
        if (autosaveTimer) {
            clearTimeout(autosaveTimer);
        }
        // Schedule new autosave
        autosaveTimer = setTimeout(doAutosave, 1000);
    }

    // Cancel pending autosave
    function cancelAutosave() {
        if (autosaveTimer) {
            clearTimeout(autosaveTimer);
            autosaveTimer = null;
        }
    }

    const context = {
        editor: null, // Will be set after creating CodeMirror
        originInput,
        namespace,
        close: (reason) => close(reason || 'manual'),
        focusEditor: () => {
            try {
                cmEditor?.focus();
            } catch (_) {}
        },
        setValue: (next) => {
            const str = next != null ? String(next) : '';
            if (cmEditor) {
                cmEditor.setValue(str);
            }
            lastValue = str;
            if (syncOrigin && originInput && originInput.value !== str) {
                originInput.value = str;
            }
        },
    };

    function syncOriginValue(value) {
        if (!syncOrigin || !originInput) return;
        const str = value != null ? String(value) : '';
        if (originInput.value !== str) {
            originInput.value = str;
        }
    }

    function invokeCallback(fn, value, trigger) {
        if (typeof fn === 'function') {
            try {
                fn(value, context, trigger);
            } catch (_) {}
        }
    }

    function persist(value, trigger) {
        const str = value != null ? String(value) : '';
        if (str === lastValue) {
            syncOriginValue(str);
            return;
        }
        lastValue = str;
        syncOriginValue(str);
        invokeCallback(options.onChange, str, trigger || 'change');

        // Schedule autosave when value changes (but not during close)
        if (trigger !== 'close' && trigger !== 'submit') {
            scheduleAutosave();
        }
    }

    function handleKeyDown(event) {
        if (!event) return;
        // Escape is handled by ManagedWindow
        const isCtrl = event.ctrlKey || event.metaKey;
        if (isCtrl && (event.key === 's' || event.key === 'S')) {
            event.preventDefault();
            const value = cmEditor?.getValue() ?? '';
            persist(value, 'submit');
            invokeCallback(options.onSubmit, value, 'shortcut');
            return;
        }
        if (event.key === 'Enter' && isCtrl) {
            event.preventDefault();
            const value = cmEditor?.getValue() ?? '';
            persist(value, 'submit');
            invokeCallback(options.onSubmit, value, 'shortcut');
            close('enter');
            return;
        }
        // Note: preventMultiline is handled by CodeMirror's singleLine mode
    }

    function removeListeners() {
        listeners.forEach(([element, type, handler]) => {
            if (element && type && typeof handler === 'function') {
                try {
                    element.removeEventListener(type, handler);
                } catch (_) {}
            }
        });
        listeners.length = 0;
    }

    function close(reason) {
        if (closed) return;
        closed = true;

        // Cancel any pending autosave timer
        cancelAutosave();
        if (savedIndicatorTimer) {
            clearTimeout(savedIndicatorTimer);
            savedIndicatorTimer = null;
        }

        const finalValue = cmEditor?.getValue() ?? lastValue;
        // Store the final value so getValue() returns correct value after editor disposal
        // This prevents reconnecting fields from getting an empty string
        finalValueOnClose = finalValue;

        // Get callbacks BEFORE removing from tracking
        const entry = openWindows.get(windowId);
        const autoSaveCallback = entry?.callbacks?.onAutoSave ?? options.onAutoSave;
        const closeCallback = entry?.callbacks?.onClose ?? options.onClose;

        // IMPORTANT: Remove from tracking BEFORE calling callbacks that may trigger re-renders.
        // This prevents a newly created ExpressionField from trying to reconnect to this
        // closing modal and incorrectly reading an empty value.
        openWindows.delete(windowId);

        persist(finalValue, 'close');

        // Trigger final autosave if value changed since last save
        if (finalValue !== lastSavedValue) {
            lastSavedValue = finalValue;
            if (typeof autoSaveCallback === 'function') {
                try {
                    autoSaveCallback(finalValue, context, 'close');
                } catch (_) {}
            }
        }

        // Cleanup CodeMirror editor
        try {
            cmEditor?.dispose();
        } catch (_) {}
        cmEditor = null;

        removeListeners();

        // Call close callback (uses stored reference from before tracking removal)
        if (typeof closeCallback === 'function') {
            try {
                closeCallback(finalValue, context, reason || 'close');
            } catch (_) {}
        }

        // Close ManagedWindow if not already closing from it
        if (reason !== 'window-close' && expressionWindow) {
            windowClosePending = true;
            expressionWindow.close();
        }

        if (originInput) {
            requestAnimationFrame(() => {
                try {
                    originInput.focus();
                    const len = originInput.value?.length || 0;
                    if (typeof originInput.setSelectionRange === 'function') {
                        originInput.setSelectionRange(len, len);
                    }
                } catch (_) {}
            });
        }
    }

    // Set the closeRef so the ManagedWindow onClose can use it
    closeRef = close;

    // Global keydown for Ctrl+S, Ctrl+Enter (Escape is handled by ManagedWindow)
    const globalKeyDown = (event) => {
        if (closed) return;
        // Only handle if this window is focused (on top)
        if (!expressionWindow.isVisible || expressionWindow.isMinimized) return;
        // Skip Escape - ManagedWindow handles it
        if (event.key === 'Escape') return;
        handleKeyDown(event);
    };
    document.addEventListener('keydown', globalKeyDown);
    listeners.push([document, 'keydown', globalKeyDown]);

    // Create CodeMirror editor
    // IMPORTANT: allowedVariables MUST be passed through from the expression field
    // to maintain autocomplete/validation restrictions. See architecture docs below.
    const allowedVariables = options.allowedVariables ?? null;
    const allowedVariablesProvider = options.allowedVariablesProvider ?? null;

    // Get initial allowed variables from provider if available
    const resolveAllowedVars = () => {
        if (typeof allowedVariablesProvider === 'function') {
            try {
                const value = allowedVariablesProvider();
                if (Array.isArray(value)) {
                    return value.filter(Boolean);
                }
                // Provider returned null - restrict to builtins only
                return [];
            } catch (_) {
                return [];
            }
        }
        return allowedVariables;
    };

    try {
        cmEditor = new EcolangEditor({
            parent: editorContainer,
            value: initialValue,
            singleLine: preventMultiline,
            readonly: false,
            placeholder: options.placeholder || 'Enter expression',
            allowDeclarations: false,
            // CRITICAL: Pass through allowedVariables to maintain restrictions
            // null = no restriction (e.g., Godley tables)
            // [] = restrict to builtins only (no connections)
            // ['x', 'y'] = restrict to these variables (connected vars)
            allowedVariables: resolveAllowedVars(),
            expressionServices: expressionServices,
            namespaceId: namespace,
            showLineNumbers: !preventMultiline,
            unknownAsWarnings: true,
            onChange: (value) => {
                persist(value, 'input');
            },
        });

        // Store reference in context
        context.editor = cmEditor;

    } catch (err) {
        console.warn('[ExpressionModal] Failed to create CodeMirror editor', err);

        // Fallback to simple textarea if CodeMirror fails
        const fallbackEditor = document.createElement('textarea');
        fallbackEditor.className = 'expression-modal__editor expression-modal__editor--fallback';
        fallbackEditor.value = initialValue;
        fallbackEditor.placeholder = options.placeholder || 'Enter expression';
        fallbackEditor.spellcheck = false;
        editorContainer.appendChild(fallbackEditor);

        fallbackEditor.addEventListener('input', () => persist(fallbackEditor.value, 'input'));
        listeners.push([fallbackEditor, 'input', () => persist(fallbackEditor.value, 'input')]);

        // Create a mock editor object for the API
        cmEditor = {
            getValue: () => fallbackEditor.value,
            setValue: (v) => { fallbackEditor.value = v; },
            focus: () => fallbackEditor.focus(),
            dispose: () => {},
            dom: fallbackEditor,
        };
        context.editor = cmEditor;
    }

    // Focus editor
    requestAnimationFrame(() => {
        try {
            cmEditor?.focus();
        } catch (_) {}
    });

    const modalHandle = {
        editor: cmEditor,
        originInput,
        window: expressionWindow,
        close,
        // Return finalValueOnClose if modal is closed/closing (editor disposed)
        // This prevents reconnecting fields from getting an empty string
        getValue: () => {
            if (closed && finalValueOnClose != null) {
                return finalValueOnClose;
            }
            return cmEditor?.getValue() ?? lastValue;
        },
        setValue: (next) => context.setValue(next),
    };

    // Track this window with mutable callbacks that can be updated on reconnect
    const entry = {
        window: expressionWindow,
        modal: modalHandle,
        originInput,
        // Mutable callbacks - can be updated by transferModalOwnership
        callbacks: {
            onChange: options.onChange,
            onClose: options.onClose,
            onAutoSave: options.onAutoSave,
        },
    };
    openWindows.set(windowId, entry);

    // Update invokeCallback to use entry.callbacks for onChange
    // This allows callbacks to be updated when a field reconnects
    const originalInvokeCallback = invokeCallback;
    invokeCallback = (fn, value, trigger) => {
        // For onChange, use the entry's callback (may be updated)
        if (fn === options.onChange && entry.callbacks.onChange) {
            originalInvokeCallback(entry.callbacks.onChange, value, trigger);
        } else {
            originalInvokeCallback(fn, value, trigger);
        }
    };

    invokeCallback(options.onOpen, initialValue, 'open');

    return modalHandle;
}

/**
 * ExpressionModal singleton API.
 * Matches the legacy window.ExpressionModal interface.
 */
export const ExpressionModal = {
    open: openExpressionModal,
    close: closeActiveModal,
    getActive: () => {
        // Return the most recently focused window's modal
        for (const entry of openWindows.values()) {
            if (entry.window?.isVisible && !entry.window?.isMinimized) {
                return entry.modal;
            }
        }
        return null;
    },
};
