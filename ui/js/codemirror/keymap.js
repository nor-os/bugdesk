/**
 * EcoLang Keymap for CodeMirror 6
 *
 * Custom keybindings for the EcoLang editor:
 * - Tab/Shift+Tab for indentation
 * - Enter handling (auto-indent, return line protection, single-line mode)
 * - Visual feedback for blocked actions
 */

import { keymap, EditorView } from '@codemirror/view';
import { insertTab, indentLess, insertNewlineAndIndent } from '@codemirror/commands';
import { acceptCompletion, completionStatus } from '@codemirror/autocomplete';
import { Facet, Prec } from '@codemirror/state';

// ============================================================================
// Configuration Facets
// ============================================================================

/**
 * Facet for single-line mode
 * When true, Enter key is blocked (no newlines allowed)
 */
export const singleLineFacet = Facet.define({
    combine: (values) => values.some((v) => v),
});

/**
 * Facet for allowing declarations (enables return line protection)
 * When true, Enter is blocked on lines starting with 'return'
 */
export const allowDeclarationsFacet = Facet.define({
    combine: (values) => values.some((v) => v),
});

/**
 * Facet for readonly mode
 */
export const readonlyFacet = Facet.define({
    combine: (values) => values.some((v) => v),
});

// ============================================================================
// Blink Effect
// ============================================================================

/**
 * Trigger a blink effect on the editor to indicate a blocked action
 * @param {EditorView} view - CodeMirror editor view
 */
function triggerBlink(view) {
    const dom = view.dom;

    // Remove existing animation class
    dom.classList.remove('cm-blink');

    // Force reflow to restart animation
    void dom.offsetWidth;

    // Add animation class
    dom.classList.add('cm-blink');

    // Remove after animation completes (2 seconds)
    setTimeout(() => {
        dom.classList.remove('cm-blink');
    }, 2000);
}

// ============================================================================
// Key Handlers
// ============================================================================

/**
 * Handle Tab key - accept completion if active, otherwise indent or move focus
 */
function handleTab(view) {
    const readonly = view.state.facet(readonlyFacet);
    if (readonly) return false;

    // If autocomplete is active, Tab should accept the selected completion
    if (completionStatus(view.state) === 'active') {
        return acceptCompletion(view);
    }

    // In single-line mode, Tab should move focus to next element
    const singleLine = view.state.facet(singleLineFacet);
    if (singleLine) {
        // Move focus to next focusable element in tab order
        const focusables = Array.from(document.querySelectorAll(
            'input:not([disabled]):not([tabindex="-1"]), ' +
            'select:not([disabled]):not([tabindex="-1"]), ' +
            'textarea:not([disabled]):not([tabindex="-1"]), ' +
            'button:not([disabled]):not([tabindex="-1"]), ' +
            '[tabindex]:not([tabindex="-1"]):not([disabled]), ' +
            '.cm-content'
        ));
        const currentIndex = focusables.indexOf(view.contentDOM);
        if (currentIndex >= 0 && currentIndex < focusables.length - 1) {
            focusables[currentIndex + 1].focus();
            return true;
        }
        return false;
    }

    return insertTab(view);
}

/**
 * Handle Shift+Tab - remove indentation or move focus backwards
 */
function handleShiftTab(view) {
    const readonly = view.state.facet(readonlyFacet);
    if (readonly) return false;

    // In single-line mode, Shift+Tab should move focus to previous element
    const singleLine = view.state.facet(singleLineFacet);
    if (singleLine) {
        const focusables = Array.from(document.querySelectorAll(
            'input:not([disabled]):not([tabindex="-1"]), ' +
            'select:not([disabled]):not([tabindex="-1"]), ' +
            'textarea:not([disabled]):not([tabindex="-1"]), ' +
            'button:not([disabled]):not([tabindex="-1"]), ' +
            '[tabindex]:not([tabindex="-1"]):not([disabled]), ' +
            '.cm-content'
        ));
        const currentIndex = focusables.indexOf(view.contentDOM);
        if (currentIndex > 0) {
            focusables[currentIndex - 1].focus();
            return true;
        }
        return false;
    }

    return indentLess(view);
}

/**
 * Handle Enter key with special logic:
 * - In single-line mode: accept completion if active, then blur to save
 * - Block on return lines (unless cursor is before 'return')
 * - Auto-indent on normal lines
 */
function handleEnter(view) {
    const readonly = view.state.facet(readonlyFacet);
    if (readonly) return false;

    const singleLine = view.state.facet(singleLineFacet);
    const allowDeclarations = view.state.facet(allowDeclarationsFacet);

    // In single-line mode, Enter accepts completion (if active) then blurs to save
    if (singleLine) {
        // If autocomplete is active, accept the completion first
        if (completionStatus(view.state) === 'active') {
            acceptCompletion(view);
        }
        // Schedule blur for next frame to ensure completion is fully processed
        // and state is settled before triggering save
        requestAnimationFrame(() => {
            view.contentDOM.blur();
        });
        return true; // Handled - prevent default
    }

    // Check for return line protection
    if (allowDeclarations) {
        const state = view.state;
        const pos = state.selection.main.head;
        const line = state.doc.lineAt(pos);
        const lineText = line.text;

        // Check if this line starts with 'return' (with optional leading whitespace)
        const returnMatch = lineText.match(/^(\s*)return\b/);
        if (returnMatch) {
            const leadingWhitespace = returnMatch[1].length;
            const cursorPosInLine = pos - line.from;

            // Block Enter if cursor is at or after the 'r' in 'return'
            // Allow Enter only if cursor is before 'return' (to insert lines above)
            if (cursorPosInLine > leadingWhitespace) {
                triggerBlink(view);
                return true; // Handled - prevent default
            }
        }
    }

    // Default: insert newline with auto-indent
    return insertNewlineAndIndent(view);
}

/**
 * Handle Escape key - could be used to close autocomplete or blur
 */
function handleEscape(view) {
    // Let autocomplete handle Escape first
    return false;
}

// ============================================================================
// High-Priority Enter Handler for Single-Line Mode
// ============================================================================

/**
 * High-priority DOM event handler for Enter key in single-line mode.
 *
 * This extension uses Prec.highest to ensure it runs BEFORE CodeMirror's
 * autocomplete plugin intercepts the Enter key. Without this, when autocomplete
 * is open and Enter is pressed, autocomplete accepts the completion but our
 * blur/save logic never runs.
 *
 * Flow:
 * 1. Enter pressed -> this handler runs first
 * 2. If single-line mode and autocomplete is active:
 *    - Accept the completion programmatically
 *    - Schedule blur for next frame (triggers save)
 *    - Prevent default and stop propagation
 * 3. If single-line mode but no autocomplete:
 *    - Schedule blur (triggers save)
 *    - Prevent default
 */
export const singleLineEnterHandler = Prec.highest(
    EditorView.domEventHandlers({
        keydown(event, view) {
            // Only handle Enter key
            if (event.key !== 'Enter') return false;

            const readonly = view.state.facet(readonlyFacet);
            if (readonly) return false;

            const singleLine = view.state.facet(singleLineFacet);
            if (!singleLine) return false;

            // In single-line mode, accept any active completion, then blur to save
            if (completionStatus(view.state) === 'active') {
                acceptCompletion(view);
            }

            // Schedule blur for next frame to ensure:
            // 1. Completion is fully processed if one was active
            // 2. Editor state is settled
            // 3. onBlur callback fires and triggers save
            requestAnimationFrame(() => {
                view.contentDOM.blur();
            });

            // Prevent default (newline) and stop propagation
            event.preventDefault();
            event.stopPropagation();
            return true;
        },
    })
);

// ============================================================================
// Keymap Definition
// ============================================================================

/**
 * EcoLang custom keymap
 *
 * Note: Enter key in single-line mode is now handled by singleLineEnterHandler
 * (a high-priority DOM event handler) to ensure it runs before autocomplete.
 * The Enter handler here still exists for multiline mode and as a fallback.
 */
export const ecolangKeymap = keymap.of([
    // Tab handling
    { key: 'Tab', run: handleTab },
    { key: 'Shift-Tab', run: handleShiftTab },

    // Enter handling (for multiline mode - single-line is handled by singleLineEnterHandler)
    { key: 'Enter', run: handleEnter },

    // Escape (let default handlers work)
    { key: 'Escape', run: handleEscape },
]);

/**
 * Additional keybindings for the function editor
 * (e.g., Ctrl+S to save - handled by parent component)
 */
export const functionEditorKeymap = keymap.of([
    // Ctrl+S is typically handled by the parent component
    // but we can prevent default browser behavior
    {
        key: 'Mod-s',
        run: () => {
            // Dispatch custom event for parent to handle
            document.dispatchEvent(new CustomEvent('ecolang-editor:save'));
            return true;
        },
    },

    // Ctrl+Enter to submit (for modal editors)
    {
        key: 'Mod-Enter',
        run: () => {
            document.dispatchEvent(new CustomEvent('ecolang-editor:submit'));
            return true;
        },
    },
]);

// ============================================================================
// Exports
// ============================================================================

export { triggerBlink };

export default ecolangKeymap;
