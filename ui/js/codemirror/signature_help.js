/**
 * EcoLang Signature Help for CodeMirror 6
 *
 * Provides function signature/parameter hints when typing inside function calls.
 * Shows a tooltip with the function signature and highlights the current parameter.
 */

import { EditorView, showTooltip } from '@codemirror/view';
import { StateField, Facet } from '@codemirror/state';
import { parseImportsFromCode, moduleImportsFacet } from './autocomplete.js';

// ============================================================================
// Configuration Facets
// ============================================================================

/**
 * Facet for function signatures lookup
 * Provides a function that returns signature info for a given function name
 */
export const signatureLookupFacet = Facet.define({
    combine: (values) => values[0] || null,
});

// ============================================================================
// Signature Parsing
// ============================================================================

/**
 * Parse the text before cursor to find if we're inside a function call
 * Returns { functionName, paramIndex } or null
 */
function parseCallContext(doc, pos) {
    const text = doc.sliceString(0, pos);

    // Work backwards to find unclosed parenthesis
    let depth = 0;
    let paramIndex = 0;
    let funcEnd = -1;

    for (let i = text.length - 1; i >= 0; i--) {
        const ch = text[i];

        if (ch === ')') {
            depth++;
        } else if (ch === '(') {
            if (depth === 0) {
                // Found the opening paren of our call
                funcEnd = i;
                break;
            }
            depth--;
        } else if (ch === ',' && depth === 0) {
            paramIndex++;
        }
    }

    if (funcEnd === -1) return null;

    // Extract function name (work backwards from the '(')
    let funcStart = funcEnd - 1;
    while (funcStart >= 0) {
        const ch = text[funcStart];
        if (/[A-Za-z0-9_.]/.test(ch)) {
            funcStart--;
        } else {
            break;
        }
    }
    funcStart++;

    if (funcStart >= funcEnd) return null;

    const functionName = text.slice(funcStart, funcEnd).trim();
    if (!functionName) return null;

    return { functionName, paramIndex, openParen: funcEnd };
}

/**
 * Get function signature from various sources
 */
function lookupSignature(functionName, state) {
    const customLookup = state.facet(signatureLookupFacet);
    if (customLookup) {
        const result = customLookup(functionName);
        if (result) return result;
    }

    // Try global builtins (window.EcoLangBuiltins)
    const builtins = window.EcoLangBuiltins;
    if (builtins?.byName) {
        const fn = builtins.byName.get(functionName);
        if (fn) {
            return parseSignatureString(fn.signature, fn.description);
        }
    }

    // Try expressionServices from global
    const expressionServices = window.__ECOSIM_JS_NEW__?.expressionServices;
    if (expressionServices) {
        // First, check builtins from expressionServices (direct functions like pow, sin)
        const esBuiltins = expressionServices.getBuiltins?.();
        if (esBuiltins?.functions) {
            const fn = esBuiltins.functions.find(f => f.name === functionName);
            if (fn) {
                return parseSignatureString(fn.signature, fn.description);
            }
        }

        // Check if it's a qualified name like "Module.func"
        if (expressionServices.moduleRegistry) {
            const dotIdx = functionName.lastIndexOf('.');
            if (dotIdx > 0) {
                const moduleName = functionName.slice(0, dotIdx);
                const funcName = functionName.slice(dotIdx + 1);
                const exported = expressionServices.moduleRegistry.getExportedFunctions?.(moduleName);
                if (exported?.[funcName]) {
                    const fn = exported[funcName];
                    return {
                        name: functionName,
                        params: fn.params || [],
                        description: fn.description || '',
                        paramDescriptions: fn.paramDescriptions || null,
                        signature: fn.signature || `${funcName}(${(fn.params || []).join(', ')})`,
                    };
                }
            }

            // Check if it's an imported bare function name
            // Merge imports from two sources:
            // 1. Code-level imports parsed from the document
            // 2. Facet-based imports (e.g., sibling module functions from functions page)
            const docText = state.doc.toString();
            const codeImports = parseImportsFromCode(docText);
            const facetImports = state.facet(moduleImportsFacet) || [];
            const imports = [...codeImports, ...facetImports];

            for (const imp of imports) {
                if (!imp?.moduleName) continue;

                const exported = expressionServices.moduleRegistry.getExportedFunctions?.(imp.moduleName);
                if (!exported) continue;

                // Check if this function name matches an imported function (or its alias)
                const { functions: importedFuncs = [], aliases = {} } = imp;

                // If functions is empty, all are imported
                const isAllImported = !importedFuncs.length;

                // Check aliases first (functionName could be an alias)
                for (const [origName, aliasName] of Object.entries(aliases)) {
                    if (aliasName === functionName && exported[origName]) {
                        const fn = exported[origName];
                        return {
                            name: functionName,
                            params: fn.params || [],
                            description: fn.description || '',
                            paramDescriptions: fn.paramDescriptions || null,
                            signature: fn.signature || `${origName}(${(fn.params || []).join(', ')})`,
                        };
                    }
                }

                // Check if function was explicitly imported or all functions are imported
                if ((isAllImported || importedFuncs.includes(functionName)) && exported[functionName]) {
                    const fn = exported[functionName];
                    return {
                        name: functionName,
                        params: fn.params || [],
                        description: fn.description || '',
                        paramDescriptions: fn.paramDescriptions || null,
                        signature: fn.signature || `${functionName}(${(fn.params || []).join(', ')})`,
                    };
                }
            }
        }
    }

    return null;
}

/**
 * Parse a signature string like "pow(x, y)" into structured form
 */
function parseSignatureString(signature, description = '') {
    const match = signature.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*\(([^)]*)\)/);
    if (!match) return null;

    const name = match[1];
    const paramsStr = match[2];
    const params = paramsStr
        .split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0);

    return { name, params, description, signature };
}

// ============================================================================
// Tooltip Creation
// ============================================================================

/**
 * Create the signature help tooltip content
 */
function createSignatureTooltip(info, paramIndex) {
    const dom = document.createElement('div');
    dom.className = 'cm-signature-help';

    // Signature line with highlighted parameter
    const sigLine = document.createElement('div');
    sigLine.className = 'cm-signature-line';

    // Function name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'cm-signature-name';
    nameSpan.textContent = info.name + '(';
    sigLine.appendChild(nameSpan);

    // Parameters
    info.params.forEach((param, idx) => {
        if (idx > 0) {
            const comma = document.createElement('span');
            comma.className = 'cm-signature-punct';
            comma.textContent = ', ';
            sigLine.appendChild(comma);
        }

        const paramSpan = document.createElement('span');
        paramSpan.className = idx === paramIndex
            ? 'cm-signature-param cm-signature-param-active'
            : 'cm-signature-param';
        paramSpan.textContent = param;
        sigLine.appendChild(paramSpan);
    });

    const closeParen = document.createElement('span');
    closeParen.className = 'cm-signature-punct';
    closeParen.textContent = ')';
    sigLine.appendChild(closeParen);

    dom.appendChild(sigLine);

    // Active parameter description (if available)
    if (info.paramDescriptions) {
        const activeParam = info.params[paramIndex];
        const paramDesc = activeParam && info.paramDescriptions[activeParam];
        if (paramDesc) {
            const paramDescLine = document.createElement('div');
            paramDescLine.className = 'cm-signature-param-description';
            paramDescLine.textContent = `${activeParam}: ${paramDesc}`;
            dom.appendChild(paramDescLine);
        }
    }

    // Description if available
    if (info.description) {
        const descLine = document.createElement('div');
        descLine.className = 'cm-signature-description';
        descLine.textContent = info.description;
        dom.appendChild(descLine);
    }

    return dom;
}

// ============================================================================
// State Field for Signature Help
// ============================================================================

const signatureHelpState = StateField.define({
    create() {
        return null;
    },

    update(value, tr) {
        // Only update on document changes or selection changes
        if (!tr.docChanged && !tr.selection) {
            return value;
        }

        const pos = tr.state.selection.main.head;
        const context = parseCallContext(tr.state.doc, pos);

        if (!context) return null;

        const sigInfo = lookupSignature(context.functionName, tr.state);
        if (!sigInfo) return null;

        // Return tooltip info
        return {
            pos: context.openParen,
            sigInfo,
            paramIndex: Math.min(context.paramIndex, sigInfo.params.length - 1),
        };
    },

    provide: (field) => showTooltip.compute([field], (state) => {
        const data = state.field(field);
        if (!data) return null;

        return {
            pos: data.pos,
            above: true,
            strictSide: true,
            arrow: false,
            create: () => ({
                dom: createSignatureTooltip(data.sigInfo, data.paramIndex),
            }),
        };
    }),
});

// ============================================================================
// Theme for Signature Help Tooltips
// ============================================================================

const signatureHelpTheme = EditorView.baseTheme({
    '.cm-signature-help': {
        backgroundColor: '#1e1e1e',
        color: '#e6edf3',
        border: '1px solid #3a3a3a',
        borderRadius: '6px',
        padding: '6px 10px',
        fontSize: '12px',
        fontFamily: 'Consolas, "Courier New", monospace',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
        maxWidth: '400px',
    },
    '.cm-signature-line': {
        whiteSpace: 'nowrap',
    },
    '.cm-signature-name': {
        color: '#a6e22e',
    },
    '.cm-signature-param': {
        color: '#9cdcfe',
    },
    '.cm-signature-param-active': {
        color: '#ffd76d',
        fontWeight: 'bold',
        textDecoration: 'underline',
    },
    '.cm-signature-punct': {
        color: '#808080',
    },
    '.cm-signature-param-description': {
        color: '#c0d0e0',
        marginTop: '3px',
        fontSize: '11px',
        whiteSpace: 'normal',
        borderLeft: '2px solid #ffd76d',
        paddingLeft: '6px',
    },
    '.cm-signature-description': {
        color: '#9aa7b0',
        marginTop: '4px',
        fontSize: '11px',
        fontStyle: 'italic',
        whiteSpace: 'normal',
    },
});

// ============================================================================
// Export
// ============================================================================

/**
 * Complete signature help extension
 * Add this to your editor extensions to enable function parameter hints
 */
export const ecolangSignatureHelp = [
    signatureHelpState,
    signatureHelpTheme,
];

export default ecolangSignatureHelp;
