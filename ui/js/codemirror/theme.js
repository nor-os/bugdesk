/**
 * EcoLang Dark Theme for CodeMirror 6
 *
 * A dark theme matching the EcoSim UI design.
 * Colors are based on the existing inline_autocomplete.css and code.css styles.
 */

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/**
 * Syntax highlighting style
 * Maps CodeMirror tags to colors matching the existing UI
 */
const highlightStyle = HighlightStyle.define([
    // Base tags first, then modified tags (order matters for matching)

    // Keywords: blue (match, return, let, lambda, etc.)
    { tag: t.keyword, color: '#569cd6' },

    // Variables: light blue (base tag - must come before modifiers)
    { tag: t.variableName, color: '#4fc1ff' },

    // Properties (after dot): light blue (base tag - must come before modifiers)
    { tag: t.propertyName, color: '#4fc1ff' },

    // Functions: green (modified tags - after base tags)
    { tag: t.function(t.variableName), color: '#a6e22e' },
    { tag: t.function(t.propertyName), color: '#a6e22e' },

    // Special variables (parameters): light cyan (modified tag)
    { tag: t.special(t.variableName), color: '#9cdcfe' },

    // Constants (e, pi, t, etc.): purple (modified tag)
    { tag: t.constant(t.variableName), color: '#c586c0' },

    // Deprecated: strike-through, dimmed (nested modified tag)
    { tag: t.special(t.function(t.variableName)), color: '#6a9955', textDecoration: 'line-through' },

    // Namespace names: yellow/gold
    { tag: t.namespace, color: '#dcdcaa' },

    // Type names (stock literals): teal
    { tag: t.typeName, color: '#4ec9b0' },

    // Constants as atoms: purple
    { tag: t.atom, color: '#c586c0' },

    // Numbers: light green
    { tag: t.number, color: '#b5cea8' },

    // Strings: orange
    { tag: t.string, color: '#ce9178' },

    // Comments: green (dimmed)
    { tag: t.comment, color: '#6a9955' },

    // Operators: light gray
    { tag: t.operator, color: '#d4d4d4' },

    // Punctuation: medium gray
    { tag: t.punctuation, color: '#808080' },

    // Meta/directives (.MODULE, .END): purple
    { tag: t.meta, color: '#c586c0' },

    // Invalid: red
    { tag: t.invalid, color: '#f44747' },
]);

/**
 * Base editor theme
 * Styles the editor chrome (gutters, cursor, selection, etc.)
 */
const baseTheme = EditorView.theme({
    // Root editor styling
    '&': {
        backgroundColor: 'transparent',
        color: '#e6edf3',
        fontFamily: 'Consolas, "Courier New", monospace',
        fontSize: '12.5px',
        lineHeight: '1.56',
    },

    // Content area
    '.cm-content': {
        caretColor: '#39ff14',
        padding: '4px 0',
    },

    // Individual lines
    '.cm-line': {
        padding: '0 4px',
    },

    // Cursor styling
    '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: '#39ff14',
        borderLeftWidth: '2px',
    },

    // Remove focus outline (handled by parent)
    '&.cm-focused': {
        outline: 'none',
    },

    // Selection
    '.cm-selectionBackground': {
        backgroundColor: '#264f78 !important',
    },
    '&.cm-focused .cm-selectionBackground': {
        backgroundColor: '#264f78 !important',
    },

    // Matching brackets
    '.cm-matchingBracket': {
        backgroundColor: 'rgba(0, 150, 255, 0.3)',
        outline: '1px solid rgba(0, 150, 255, 0.5)',
    },
    '.cm-nonmatchingBracket': {
        backgroundColor: 'rgba(255, 0, 0, 0.3)',
    },

    // Gutters (line numbers)
    '.cm-gutters': {
        backgroundColor: '#252525',
        color: '#858585',
        border: 'none',
        borderRight: '1px solid #333',
    },

    // Active line gutter highlight
    '.cm-activeLineGutter': {
        backgroundColor: '#2a2a2a',
        color: '#c6c6c6',
    },

    // Active line highlight
    '.cm-activeLine': {
        backgroundColor: 'rgba(255, 255, 255, 0.03)',
    },

    // Fold gutters
    '.cm-foldGutter': {
        width: '12px',
    },
    '.cm-foldGutter .cm-gutterElement': {
        cursor: 'pointer',
        color: '#858585',
    },
    '.cm-foldGutter .cm-gutterElement:hover': {
        color: '#c6c6c6',
    },

    // Placeholder text
    '.cm-placeholder': {
        color: '#6b737c',
        fontStyle: 'italic',
    },

    // Search matches
    '.cm-searchMatch': {
        backgroundColor: 'rgba(255, 213, 0, 0.3)',
        outline: '1px solid rgba(255, 213, 0, 0.5)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'rgba(255, 150, 0, 0.4)',
    },

    // Autocomplete tooltip
    '.cm-tooltip': {
        backgroundColor: '#1e1e1e',
        color: '#e6edf3',
        border: '1px solid #2a2a2a',
        borderRadius: '8px',
        boxShadow: '0 12px 28px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.35)',
    },

    // Autocomplete dropdown
    '.cm-tooltip.cm-tooltip-autocomplete': {
        maxHeight: '260px',
        maxWidth: '500px',
        padding: '4px',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        fontFamily: 'Consolas, "Courier New", monospace',
        fontSize: '12.5px',
        maxHeight: '250px',
        maxWidth: '100%',
    },
    '.cm-tooltip-autocomplete ul li': {
        padding: '4px 8px',
        borderRadius: '4px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        maxWidth: '100%',
        overflow: 'hidden',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: '#094771',
        color: '#ffffff',
    },

    // Completion icons - ensure consistent sizing and alignment
    '.cm-completionIcon': {
        width: '20px',
        minWidth: '20px',
        maxWidth: '20px',
        fontSize: '14px',
        opacity: '0.9',
        textAlign: 'center',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: '0',
    },
    '.cm-completionIcon-keyword': { color: '#569cd6' },
    '.cm-completionIcon-function': { color: '#a6e22e' },
    '.cm-completionIcon-variable': { color: '#4fc1ff' },
    '.cm-completionIcon-constant': { color: '#c586c0' },
    '.cm-completionIcon-namespace': { color: '#dcdcaa' },
    '.cm-completionIcon-type': { color: '#4ec9b0' },
    '.cm-completionIcon-text': { color: '#9aa7b0' },
    '.cm-completionIcon-class': { color: '#e8ab53' },
    '.cm-completionIcon-method': { color: '#a6e22e' },
    '.cm-completionIcon-property': { color: '#4fc1ff' },

    // Completion label
    '.cm-completionLabel': {
        flex: '1',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: '0',
    },
    '.cm-completionMatchedText': {
        color: '#ffd76d',
        fontWeight: '600',
    },

    // Completion detail/type
    '.cm-completionDetail': {
        color: '#9aa7b0',
        fontStyle: 'italic',
        marginLeft: '8px',
        fontSize: '11px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flexShrink: '1',
        maxWidth: '200px',
    },

    // Completion info tooltip (the description popup)
    '.cm-completionInfo': {
        maxWidth: '350px',
        maxHeight: '200px',
        overflow: 'auto',
        padding: '8px 12px',
        fontSize: '12px',
        lineHeight: '1.4',
        whiteSpace: 'pre-wrap',
        wordWrap: 'break-word',
    },

    // Linting - warning squiggles
    '.cm-lintRange-warning': {
        backgroundImage: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0' stroke='%23f0ad4e' fill='none' stroke-width='1'/></svg>")`,
        backgroundRepeat: 'repeat-x',
        backgroundPosition: 'bottom',
        backgroundSize: '6px 3px',
    },

    // Linting - error squiggles
    '.cm-lintRange-error': {
        backgroundImage: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0' stroke='%23dc3545' fill='none' stroke-width='1'/></svg>")`,
        backgroundRepeat: 'repeat-x',
        backgroundPosition: 'bottom',
        backgroundSize: '6px 3px',
    },

    // Linting - info squiggles
    '.cm-lintRange-info': {
        backgroundImage: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0' stroke='%2317a2b8' fill='none' stroke-width='1'/></svg>")`,
        backgroundRepeat: 'repeat-x',
        backgroundPosition: 'bottom',
        backgroundSize: '6px 3px',
    },

    // Lint tooltip
    '.cm-tooltip.cm-tooltip-lint': {
        padding: '4px 8px',
        maxWidth: '400px',
    },

    // Single-line mode overrides
    '&.cm-singleLine': {
        maxHeight: '1.8em',
    },
    '&.cm-singleLine .cm-content': {
        whiteSpace: 'nowrap',
        overflow: 'hidden',
    },
    '&.cm-singleLine .cm-scroller': {
        overflow: 'hidden !important',
    },
    '&.cm-singleLine .cm-line': {
        paddingTop: '0',
        paddingBottom: '0',
    },

    // Blink animation (for blocked actions like Enter on return line)
    '&.cm-blink': {
        animation: 'cm-blink-anim 2s ease-out',
    },

    // Panel styling (for search/replace panel)
    '.cm-panels': {
        backgroundColor: '#252525',
        color: '#e6edf3',
        borderTop: '1px solid #333',
    },
    '.cm-panels input, .cm-panels button': {
        fontFamily: 'inherit',
        fontSize: '12px',
    },
    '.cm-textfield': {
        backgroundColor: '#1e1e1e',
        color: '#e6edf3',
        border: '1px solid #3c3c3c',
        borderRadius: '4px',
        padding: '2px 6px',
    },
    '.cm-textfield:focus': {
        borderColor: '#007acc',
        outline: 'none',
    },
    '.cm-button': {
        backgroundColor: '#0e639c',
        color: '#ffffff',
        border: 'none',
        borderRadius: '4px',
        padding: '2px 8px',
        cursor: 'pointer',
    },
    '.cm-button:hover': {
        backgroundColor: '#1177bb',
    },
}, { dark: true });

/**
 * Keyframes for blink animation (injected into document)
 */
const blinkKeyframes = `
@keyframes cm-blink-anim {
    0%, 5%, 10%, 15%, 20%, 30%, 45%, 70% {
        box-shadow: inset 0 0 0 2000px rgba(220, 50, 47, 0.25);
    }
    2.5%, 7.5%, 12.5%, 17.5%, 25%, 37.5%, 57.5%, 100% {
        box-shadow: none;
    }
}
`;

// Inject keyframes if not already present
if (typeof document !== 'undefined' && !document.getElementById('cm-ecolang-keyframes')) {
    const style = document.createElement('style');
    style.id = 'cm-ecolang-keyframes';
    style.textContent = blinkKeyframes;
    document.head.appendChild(style);
}

/**
 * Complete EcoLang theme (base + syntax highlighting)
 */
export const ecolangTheme = [
    baseTheme,
    syntaxHighlighting(highlightStyle),
];

/**
 * Just the syntax highlighting (for use with other base themes)
 */
export const ecolangHighlighting = syntaxHighlighting(highlightStyle);

/**
 * Just the base theme (for use with other syntax highlighting)
 */
export const ecolangBaseTheme = baseTheme;

export default ecolangTheme;
