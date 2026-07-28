/**
 * EcoLang Monaco Language Registration
 *
 * Registers EcoLang as a Monaco language with:
 *   - Monarch tokenizer (syntax highlighting)
 *   - Language configuration (brackets, comments, auto-indent)
 *   - CompletionItemProvider (context-aware autocomplete)
 *   - SignatureHelpProvider (function parameter hints)
 *   - HoverProvider (variable/function/stock info)
 *   - DiagnosticsProvider (inline error/warning markers)
 *   - DocumentSymbolProvider (document outline)
 *
 * Usage:
 *   import { registerEcoLang } from './ecolang_monaco.js';
 *   const monaco = await monacoReady;
 *   registerEcoLang(monaco, { symbolProvider: () => symbolIndex.symbols });
 */

import { FUNCTIONS_BY_NAME, CONSTANTS_BY_NAME, DEPRECATED_BY_NAME } from '../utils/ecolang_builtins.js';

export const ECOLANG_ID = 'ecolang';

// ─── Static keyword / token lists ─────────────────────────────────────────────

const KEYWORDS = [
    'match', 'with', 'when', 'using', 'steepness',
    'lambda', 'return', 'let', 'import', 'from', 'as',
    'namespace', 'module',
];

const EXPR_KEYWORDS = ['if', 'else', 'and', 'or', 'not'];

const CONSTANTS = ['e', 'pi', 't', 't0', 'dt', 'inf', 'nan', 'true', 'false'];

const DIRECTIVES = [
    'MODULE', 'END', 'DESCRIPTION', 'READONLY', 'IMPORT', 'EXPORT',
    'PARAM', 'STOCK', 'FLOW',
];

// ─── Monarch tokenizer definition ─────────────────────────────────────────────

function buildMonarchTokenizer(functionNames = []) {
    return {
        keywords: KEYWORDS,
        constants: CONSTANTS,
        directives: DIRECTIVES,
        functions: functionNames,

        tokenizer: {
            root: [
                [/^\.[A-Z][A-Z0-9_]*/, 'keyword.directive'],
                [/[;#].*$/, 'comment'],
                [/\bd\s*\/\s*dt\b/, 'keyword'],
                [/\/\s*dt\b/, 'keyword'],
                [/[A-Za-z_]\w*::[A-Za-z_]\w*\[[^\]]*\]/, 'type.identifier'],
                [/[A-Za-z_]\w*\[[^\]]*\]/, 'type.identifier'],
                [/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, 'number'],
                [/"(?:[^"\\]|\\.)*"/, 'string'],
                [/'(?:[^'\\]|\\.)*'/, 'string'],
                [/[A-Za-z_]\w*/, {
                    cases: {
                        '@keywords':  'keyword',
                        '@constants': 'constant',
                        '@functions': 'support.function',
                        '@default':   'identifier',
                    },
                }],
                [/->/, 'keyword.operator'],
                [/[+\-*/%^]=?|[=!<>]=?|&&|\|\|/, 'operator'],
                [/[(),[\]{}]/, 'delimiter'],
                [/[.]/, 'delimiter'],
                [/\s+/, 'white'],
            ],
        },
    };
}

// ─── Language configuration ────────────────────────────────────────────────────

const LANGUAGE_CONF = {
    comments: { lineComment: ';' },
    brackets: [['(', ')'], ['[', ']'], ['{', '}']],
    autoClosingPairs: [
        { open: '(', close: ')' },
        { open: '[', close: ']' },
        { open: '{', close: '}' },
        { open: '"', close: '"' },
    ],
    surroundingPairs: [
        { open: '(', close: ')' },
        { open: '[', close: ']' },
        { open: '"', close: '"' },
    ],
    indentationRules: {
        increaseIndentPattern: /^\s*(match|with|module)\b.*$/,
        decreaseIndentPattern: /^\s*(return|\.END)\b/,
    },
    wordPattern: /[A-Za-z_]\w*/,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a function signature string like "foo(x, [y], z)" into param names. */
function parseSignatureParams(signature) {
    if (!signature) return [];
    const match = signature.match(/\(([^)]*)\)/);
    if (!match) return [];
    return match[1].split(',').map(p => p.trim()).filter(Boolean);
}

/** Map symbol kind to Monaco CompletionItemKind. */
function symbolKindToCompletionKind(CK, kind) {
    switch (kind) {
        case 'stock':     return CK.Class;
        case 'flow':      return CK.Method;
        case 'module':    return CK.Module;
        case 'import':    return CK.Module;
        case 'namespace': return CK.Enum;
        case 'parameter': return CK.Property;
        default:          return CK.Variable;
    }
}

/** Map symbol kind to Monaco SymbolKind. */
function symbolKindToDocumentSymbolKind(SK, kind) {
    switch (kind) {
        case 'namespace': return SK.Namespace;
        case 'stock':     return SK.Class;
        case 'flow':      return SK.Function;
        case 'module':    return SK.Module;
        case 'import':    return SK.Package;
        case 'parameter': return SK.Property;
        case 'variable':  return SK.Variable;
        default:          return SK.Variable;
    }
}

// ─── Provider: Completion ─────────────────────────────────────────────────────

function createCompletionProvider(monaco, symbolProvider) {
    const CK = monaco.languages.CompletionItemKind;
    const SnippetRule = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

    return {
        triggerCharacters: ['.', ':', '['],

        provideCompletionItems(model, position) {
            // Lazy-refresh Monarch tokenizer when builtins have loaded since registration
            if (_monaco && FUNCTIONS_BY_NAME.size !== _lastTokenizerFnCount) {
                _lastTokenizerFnCount = FUNCTIONS_BY_NAME.size;
                _monaco.languages.setMonarchTokensProvider(
                    ECOLANG_ID, buildMonarchTokenizer([...FUNCTIONS_BY_NAME.keys()])
                );
            }

            const word = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            };

            const lineText = model.getLineContent(position.lineNumber);
            const textBefore = lineText.substring(0, position.column - 1);

            // ── Context: after '::' → suggest account type labels ──────────
            const nsColonMatch = textBefore.match(/(\w+)::(\w*)$/);
            if (nsColonMatch) {
                return { suggestions: _stockTypeCompletions(symbolProvider, nsColonMatch[1], range, CK) };
            }

            // ── Context: after '[' inside stock path → suggest account names ──
            const bracketMatch = textBefore.match(/(\w+)::(\w+)\[([^\]]*)$/);
            if (bracketMatch) {
                return { suggestions: _stockAccountCompletions(symbolProvider, bracketMatch[1], bracketMatch[2], range, CK) };
            }

            // ── Context: after '.' → suggest namespace members ─────────────
            const dotMatch = textBefore.match(/(\w+)\.(\w*)$/);
            if (dotMatch) {
                return { suggestions: _namespaceMemberCompletions(symbolProvider, dotMatch[1], range, CK) };
            }

            // ── General completions ────────────────────────────────────────
            const suggestions = [];

            // Keywords
            for (const kw of KEYWORDS) {
                suggestions.push({ label: kw, kind: CK.Keyword, insertText: kw, detail: 'keyword', range, sortText: '3_' + kw });
            }
            for (const kw of EXPR_KEYWORDS) {
                suggestions.push({ label: kw, kind: CK.Keyword, insertText: kw, detail: 'keyword', range, sortText: '3_' + kw });
            }

            // Constants
            for (const c of CONSTANTS) {
                const meta = CONSTANTS_BY_NAME.get(c);
                suggestions.push({
                    label: c,
                    kind: CK.Constant,
                    insertText: c,
                    detail: meta ? `${c} = ${meta.value ?? '(runtime)'}` : 'constant',
                    documentation: meta ? { value: meta.description } : undefined,
                    range,
                    sortText: '2_' + c,
                });
            }

            // Built-in functions (from manifest)
            for (const [name, fn] of FUNCTIONS_BY_NAME) {
                const params = parseSignatureParams(fn.signature);
                const snippet = params.length > 0
                    ? `${name}(${params.map((p, i) => `\${${i + 1}:${p.replace(/[\[\]]/g, '')}}`).join(', ')})`
                    : `${name}(\${1})`;
                suggestions.push({
                    label: name,
                    kind: CK.Function,
                    insertText: snippet,
                    insertTextRules: SnippetRule,
                    detail: fn.signature ?? name,
                    documentation: fn.description ? { value: fn.description } : undefined,
                    range,
                    sortText: '1_' + name,
                });
            }

            // Deprecated functions (with strikethrough)
            for (const [name, dep] of DEPRECATED_BY_NAME) {
                if (FUNCTIONS_BY_NAME.has(name)) continue;
                suggestions.push({
                    label: name,
                    kind: CK.Function,
                    insertText: name + '($1)',
                    insertTextRules: SnippetRule,
                    detail: `(deprecated) ${dep.reason}`,
                    documentation: dep.replacement ? { value: `Use: ${dep.replacement}` } : undefined,
                    range,
                    sortText: '9_' + name,
                    tags: [monaco.languages.CompletionItemTag?.Deprecated].filter(Boolean),
                });
            }

            // Workspace symbols
            const symbols = symbolProvider?.() ?? [];
            for (const sym of symbols) {
                if (sym.kind === 'namespace') {
                    suggestions.push({
                        label: sym.name,
                        kind: CK.Enum,
                        insertText: sym.name,
                        detail: sym.detail || 'namespace',
                        range,
                        sortText: '0_' + sym.name,
                    });
                    continue;
                }

                const detail = sym.detail
                    || (sym.namespace ? `${sym.namespace}.${sym.kind}` : sym.kind);

                suggestions.push({
                    label: sym.name,
                    kind: symbolKindToCompletionKind(CK, sym.kind),
                    insertText: sym.name,
                    detail,
                    range,
                    sortText: '0_' + sym.name,
                });
            }

            // Directives
            for (const d of DIRECTIVES) {
                suggestions.push({
                    label: '.' + d,
                    kind: CK.Keyword,
                    insertText: '.' + d + ' ',
                    detail: 'directive',
                    range,
                    sortText: '4_' + d,
                });
            }

            return { suggestions };
        },
    };
}

/** Suggest account types (Assets, Liabilities, Equity) for a given namespace after '::'. */
function _stockTypeCompletions(symbolProvider, nsName, range, CK) {
    const symbols = symbolProvider?.() ?? [];
    const types = new Set();
    const prefix = nsName + '::';
    for (const sym of symbols) {
        if (sym.kind === 'stock' && sym.name.startsWith(prefix)) {
            const typeMatch = sym.name.match(/::([\w]+)\[/);
            if (typeMatch) types.add(typeMatch[1]);
        }
    }
    return [...types].map(t => ({
        label: t,
        kind: CK.Enum,
        insertText: t,
        detail: 'account type',
        range,
    }));
}

/** Suggest account names inside brackets for a given namespace::type. */
function _stockAccountCompletions(symbolProvider, nsName, typeName, range, CK) {
    const symbols = symbolProvider?.() ?? [];
    const accounts = [];
    const prefix = `${nsName}::${typeName}[`;
    for (const sym of symbols) {
        if (sym.kind === 'stock' && sym.name.startsWith(prefix)) {
            const accMatch = sym.name.match(/\[(\w+)\]/);
            if (accMatch) {
                accounts.push({
                    label: accMatch[1],
                    kind: CK.Field,
                    insertText: accMatch[1],
                    detail: 'stock account',
                    range,
                });
            }
        }
    }
    return accounts;
}

/** Suggest members of a namespace after '.'. */
function _namespaceMemberCompletions(symbolProvider, nsName, range, CK) {
    const symbols = symbolProvider?.() ?? [];
    const members = [];
    for (const sym of symbols) {
        if (sym.namespace === nsName || sym.name.startsWith(nsName + '::')) {
            members.push({
                label: sym.name.includes('::') ? sym.name.split('::').pop() : sym.name,
                kind: symbolKindToCompletionKind(CK, sym.kind),
                insertText: sym.name.includes('::') ? sym.name.split('::').pop() : sym.name,
                detail: sym.detail || sym.kind,
                range,
            });
        }
    }
    return members;
}

// ─── Provider: Signature Help ─────────────────────────────────────────────────

function createSignatureHelpProvider(monaco) {
    return {
        signatureHelpTriggerCharacters: ['(', ','],
        signatureHelpRetriggerCharacters: [','],

        provideSignatureHelp(model, position) {
            const lineText = model.getLineContent(position.lineNumber);
            const textBefore = lineText.substring(0, position.column - 1);

            // Walk backwards to find the function name and current parameter index
            let depth = 0;
            let commaCount = 0;
            let funcEnd = -1;

            for (let i = textBefore.length - 1; i >= 0; i--) {
                const ch = textBefore[i];
                if (ch === ')') depth++;
                else if (ch === '(') {
                    if (depth === 0) {
                        funcEnd = i;
                        break;
                    }
                    depth--;
                } else if (ch === ',' && depth === 0) {
                    commaCount++;
                }
            }

            if (funcEnd < 0) return null;

            // Extract function name before the '('
            const beforeParen = textBefore.substring(0, funcEnd).trimEnd();
            const fnNameMatch = beforeParen.match(/(\w+)\s*$/);
            if (!fnNameMatch) return null;

            const fnName = fnNameMatch[1];
            const fn = FUNCTIONS_BY_NAME.get(fnName);
            if (!fn) return null;

            const params = parseSignatureParams(fn.signature);
            if (params.length === 0) return null;

            const parameters = params.map(p => ({
                label: p,
                documentation: '',
            }));

            return {
                value: {
                    signatures: [{
                        label: fn.signature,
                        documentation: fn.description ?? '',
                        parameters,
                    }],
                    activeSignature: 0,
                    activeParameter: Math.min(commaCount, params.length - 1),
                },
                dispose() {},
            };
        },
    };
}

// ─── Provider: Hover ──────────────────────────────────────────────────────────

function createHoverProvider(monaco, symbolProvider) {
    return {
        provideHover(model, position) {
            const word = model.getWordAtPosition(position);
            if (!word) return null;
            const name = word.word;
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            };

            // Built-in function
            const fn = FUNCTIONS_BY_NAME.get(name);
            if (fn) {
                const contents = [];
                if (fn.signature) contents.push({ value: `\`\`\`ecolang\n${fn.signature}\n\`\`\`` });
                if (fn.description) contents.push({ value: fn.description });
                return { contents, range };
            }

            // Deprecated function
            const dep = DEPRECATED_BY_NAME.get(name);
            if (dep) {
                return {
                    contents: [
                        { value: `**\u26a0\ufe0f Deprecated:** ${dep.reason}` },
                        dep.replacement ? { value: `**Use instead:** ${dep.replacement}` } : null,
                    ].filter(Boolean),
                    range,
                };
            }

            // Constant
            const cnst = CONSTANTS_BY_NAME.get(name);
            if (cnst) {
                return {
                    contents: [
                        { value: `\`\`\`ecolang\n${name} = ${cnst.value ?? '(runtime)'}\n\`\`\`` },
                        cnst.description ? { value: cnst.description } : null,
                    ].filter(Boolean),
                    range,
                };
            }

            // Workspace symbol
            const symbols = symbolProvider?.() ?? [];
            const sym = symbols.find(s => s.name === name);
            if (sym) {
                const contents = [];
                const kindLabel = sym.kind.charAt(0).toUpperCase() + sym.kind.slice(1);
                let header = `**${kindLabel}:** \`${sym.name}\``;
                if (sym.namespace) header += ` *(${sym.namespace})*`;
                contents.push({ value: header });

                if (sym.kind === 'parameter' && sym.defaultValue !== undefined) {
                    contents.push({ value: `Default: \`${sym.defaultValue}\`` });
                }
                if (sym.detail) {
                    contents.push({ value: sym.detail });
                }
                if (sym.fileName) {
                    contents.push({ value: `*${sym.fileName}*` });
                }
                return { contents, range };
            }

            // Stock path hover — check full stock path at position
            const lineText = model.getLineContent(position.lineNumber);
            const stockMatch = lineText.match(/(\w+::[\w]+\[\w+\])/g);
            if (stockMatch) {
                for (const path of stockMatch) {
                    const idx = lineText.indexOf(path);
                    const start = idx + 1;
                    const end = idx + path.length + 1;
                    if (position.column >= start && position.column <= end) {
                        const stockSym = symbols.find(s => s.name === path);
                        if (stockSym) {
                            return {
                                contents: [{ value: `**Stock:** \`${path}\`` }],
                                range: {
                                    startLineNumber: position.lineNumber,
                                    endLineNumber: position.lineNumber,
                                    startColumn: start,
                                    endColumn: end,
                                },
                            };
                        }
                    }
                }
            }

            return null;
        },
    };
}

// ─── Provider: Diagnostics ────────────────────────────────────────────────────

let _diagnosticsTimer = null;
const DIAGNOSTICS_DEBOUNCE_MS = 500;

function setupDiagnostics(monaco, symbolProvider) {
    const disposables = [];

    const validate = (model) => {
        if (model.getLanguageId() !== ECOLANG_ID) return;

        const markers = [];
        const symbols = symbolProvider?.() ?? [];
        const definedNames = new Set();

        // Collect all known names
        for (const sym of symbols) definedNames.add(sym.name);
        for (const [name] of FUNCTIONS_BY_NAME) definedNames.add(name);
        for (const c of CONSTANTS) definedNames.add(c);
        for (const kw of KEYWORDS) definedNames.add(kw);
        for (const kw of EXPR_KEYWORDS) definedNames.add(kw);
        // Also add deprecated (they're valid identifiers, just warned)
        for (const [name] of DEPRECATED_BY_NAME) definedNames.add(name);
        // Add special names
        definedNames.add('_'); // wildcard in match
        definedNames.add('d'); // differential notation prefix

        const lineCount = model.getLineCount();
        let multiLineTupleLhs = null; // tracks multi-line tuple LHS: { names: string[] }
        let parenDepth = 0; // track depth across lines to skip inside function calls

        for (let lineNum = 1; lineNum <= lineCount; lineNum++) {
            const lineText = model.getLineContent(lineNum);

            // Skip comments
            if (/^\s*[;#]/.test(lineText)) continue;
            // Skip directives
            if (/^\s*\./.test(lineText)) continue;
            // Skip empty / whitespace-only
            if (!lineText.trim()) continue;

            // Count paren delta for this line (strip strings/comments first)
            let lineParenDelta = 0;
            {
                const stripped = lineText
                    .replace(/"[^"]*"/g, s => ' '.repeat(s.length))
                    .replace(/'[^']*'/g, s => ' '.repeat(s.length))
                    .replace(/[;#].*$/, '');
                for (const ch of stripped) {
                    if (ch === '(') lineParenDelta++;
                    else if (ch === ')') lineParenDelta--;
                }
            }

            // Handle multi-line tuple LHS continuation
            if (multiLineTupleLhs) {
                const trimmed = lineText.trim();
                // Check if this continuation line contains the '=' (end of LHS)
                const eqMatch = trimmed.match(/^([\w][\w.]*(?:\s*,\s*[\w][\w.]*)*)\s*(?<![!=<>])=(?!=)/);
                if (eqMatch) {
                    for (const part of eqMatch[1].split(',')) definedNames.add(part.trim());
                    for (const name of multiLineTupleLhs.names) definedNames.add(name);
                    multiLineTupleLhs = null;
                    parenDepth += lineParenDelta;
                    // Fall through to process RHS of this line normally
                } else {
                    // More continuation — collect names and skip line
                    for (const part of trimmed.replace(/,\s*$/, '').split(',')) {
                        const name = part.trim();
                        if (name && /^[\w][\w.]*$/.test(name)) multiLineTupleLhs.names.push(name);
                    }
                    parenDepth += lineParenDelta;
                    continue;
                }
            }

            // Inside a multi-line function call — skip (keyword args, not definitions)
            if (parenDepth > 0) {
                parenDepth += lineParenDelta;
                continue;
            }

            // Detect start of multi-line tuple LHS (comma-separated identifiers ending with comma)
            {
                const trimmed = lineText.trim();
                if (/^[\w][\w.]*(?:\s*,\s*[\w][\w.]*)*\s*,\s*$/.test(trimmed) && !trimmed.includes('(')) {
                    multiLineTupleLhs = { names: [] };
                    for (const part of trimmed.replace(/,\s*$/, '').split(',')) {
                        const name = part.trim();
                        if (name) multiLineTupleLhs.names.push(name);
                    }
                    parenDepth += lineParenDelta;
                    continue;
                }
            }

            // Collect LHS definitions (single, tuple, and function def parameters)
            // Allow leading whitespace so indented lines inside module bodies are recognised
            const tupleLhsMatch = lineText.match(/^\s*([\w][\w.]*(?:\s*,\s*[\w][\w.]*)*)\s*(?<![!=<>])=(?!=)/);
            if (tupleLhsMatch) {
                for (const part of tupleLhsMatch[1].split(',')) definedNames.add(part.trim());
            }
            const funcDefMatch = lineText.match(/^\s*(\w[\w.]*)\s*\(([^)]*)\)\s*=/);
            if (funcDefMatch) {
                definedNames.add(funcDefMatch[1]);
                for (const p of funcDefMatch[2].split(',')) {
                    const pname = p.trim().replace(/\s*=.*$/, '');
                    if (pname && /^\w+$/.test(pname)) definedNames.add(pname);
                }
            }

            parenDepth += lineParenDelta;

            // Check for deprecated function usage
            const identPattern = /\b([A-Za-z_]\w*)\s*\(/g;
            let m;
            while ((m = identPattern.exec(lineText)) !== null) {
                const name = m[1];
                const dep = DEPRECATED_BY_NAME.get(name);
                if (dep) {
                    markers.push({
                        severity: monaco.MarkerSeverity.Warning,
                        message: `'${name}' is deprecated: ${dep.reason}. ${dep.replacement ? 'Use: ' + dep.replacement : ''}`,
                        startLineNumber: lineNum,
                        endLineNumber: lineNum,
                        startColumn: m.index + 1,
                        endColumn: m.index + name.length + 1,
                        tags: [monaco.MarkerTag?.Deprecated].filter(Boolean),
                    });
                }
            }

            // ── Check for undefined symbols ──────────────────────────────
            // Skip structural lines (no expressions to validate)
            if (/^\s*(?:namespace|import|from)\b/i.test(lineText)) continue;

            // Build sanitized copy — blank out non-identifier regions while
            // preserving character positions so marker columns stay correct.
            let sanitized = lineText;
            // String literals
            sanitized = sanitized.replace(/"[^"]*"/g, s => ' '.repeat(s.length));
            sanitized = sanitized.replace(/'[^']*'/g, s => ' '.repeat(s.length));
            // Inline comments (after strings are blanked so ; inside strings is safe)
            sanitized = sanitized.replace(/[;#].*$/, s => ' '.repeat(s.length));
            // Differential stock refs: dSector::Type[Account]/dt
            sanitized = sanitized.replace(
                /\bd(?:[A-Za-z_]\w*\.)?[A-Za-z_]\w*::[A-Za-z_]\w*\[[^\]]*\]\s*\/\s*dt/g,
                s => ' '.repeat(s.length));
            // Stock references: [Ns.]Sector::Type[Account]
            sanitized = sanitized.replace(
                /(?:[A-Za-z_]\w*\.)?[A-Za-z_]\w*::[A-Za-z_]\w*\[[^\]]*\]/g,
                s => ' '.repeat(s.length));
            // Numbers (including scientific notation so '1e6' doesn't flag 'e')
            sanitized = sanitized.replace(
                /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, s => ' '.repeat(s.length));

            // Blank out LHS of top-level assignment (depth-0 '=' excluding comparisons)
            let depth = 0, assignIdx = -1;
            for (let ci = 0; ci < sanitized.length; ci++) {
                const ch = sanitized[ci];
                if (ch === '(' || ch === '[') { depth++; }
                else if (ch === ')' || ch === ']') { depth--; }
                else if (ch === '=' && depth === 0) {
                    if (sanitized[ci + 1] === '=') { ci++; continue; }
                    if (ci > 0 && '!<>+-*/%^'.includes(sanitized[ci - 1])) continue;
                    assignIdx = ci;
                    break;
                }
            }
            if (assignIdx >= 0) {
                sanitized = ' '.repeat(assignIdx + 1) + sanitized.slice(assignIdx + 1);
            }

            // Scan RHS for identifiers (including dotted paths)
            const symPattern = /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\b/g;
            let sm;
            while ((sm = symPattern.exec(sanitized)) !== null) {
                const ident = sm[0];
                // Skip named arguments (ident followed by = but not ==)
                const after = sanitized.slice(sm.index + ident.length).trimStart();
                if (after.startsWith('=') && !after.startsWith('==')) continue;
                // Check against known names
                if (definedNames.has(ident)) continue;
                // Dotted path: if prefix is known (namespace/instance), accept
                if (ident.includes('.') && definedNames.has(ident.split('.')[0])) continue;

                markers.push({
                    severity: monaco.MarkerSeverity.Warning,
                    message: `Undefined symbol: '${ident}'`,
                    startLineNumber: lineNum,
                    endLineNumber: lineNum,
                    startColumn: sm.index + 1,
                    endColumn: sm.index + ident.length + 1,
                });
            }
        }

        monaco.editor.setModelMarkers(model, 'ecolang', markers);
    };

    // Validate all open models
    const validateAll = () => {
        for (const model of monaco.editor.getModels()) {
            if (model.getLanguageId() === ECOLANG_ID) validate(model);
        }
    };
    _validateAllFn = validateAll;

    // Debounced validation on content change
    const onModelContentChanged = (model) => {
        if (_diagnosticsTimer) clearTimeout(_diagnosticsTimer);
        _diagnosticsTimer = setTimeout(() => validate(model), DIAGNOSTICS_DEBOUNCE_MS);
    };

    // Listen for model creation
    disposables.push(monaco.editor.onDidCreateModel((model) => {
        if (model.getLanguageId() !== ECOLANG_ID) return;
        validate(model);
        const sub = model.onDidChangeContent(() => onModelContentChanged(model));
        disposables.push(sub);
    }));

    // Validate existing models
    validateAll();

    return { dispose: () => disposables.forEach(d => d.dispose?.()) };
}

// ─── Provider: Document Symbols ───────────────────────────────────────────────

function createDocumentSymbolProvider(monaco) {
    const SK = monaco.languages.SymbolKind;

    return {
        provideDocumentSymbols(model) {
            const symbols = [];
            const lineCount = model.getLineCount();

            for (let lineNum = 1; lineNum <= lineCount; lineNum++) {
                const lineText = model.getLineContent(lineNum);
                const trimmed = lineText.trim();

                // Skip comments/empty
                if (!trimmed || /^[;#]/.test(trimmed)) continue;

                // Namespace declaration
                const nsMatch = trimmed.match(/^\.?namespace\s+(\w+)/i);
                if (nsMatch) {
                    symbols.push(_docSymbol(monaco, nsMatch[1], SK.Namespace, lineNum, model));
                    continue;
                }

                // Stock differential: dSector::Type[Account]/dt = ...
                const stockMatch = trimmed.match(/^d(\w+::\w+\[\w+\])\/dt/);
                if (stockMatch) {
                    symbols.push(_docSymbol(monaco, stockMatch[1], SK.Class, lineNum, model));
                    continue;
                }

                // Import statement
                const importMatch = trimmed.match(/^(?:import\s+(\w+)|from\s+(\w+)\s+import)/);
                if (importMatch) {
                    symbols.push(_docSymbol(monaco, importMatch[1] || importMatch[2], SK.Package, lineNum, model));
                    continue;
                }

                // Module function definition: name(params) =
                const funcMatch = trimmed.match(/^(\w+)\s*\([^)]*\)\s*=/);
                if (funcMatch) {
                    symbols.push(_docSymbol(monaco, funcMatch[1], SK.Function, lineNum, model));
                    continue;
                }

                // Variable assignment: name = ...
                const varMatch = trimmed.match(/^(\w[\w.]*)\s*=/);
                if (varMatch && !['namespace', 'return', 'let', 'import'].includes(varMatch[1])) {
                    symbols.push(_docSymbol(monaco, varMatch[1], SK.Variable, lineNum, model));
                    continue;
                }
            }

            return symbols;
        },
    };
}

function _docSymbol(monaco, name, kind, lineNum, model) {
    const lineLength = model.getLineContent(lineNum).length;
    const range = {
        startLineNumber: lineNum,
        endLineNumber: lineNum,
        startColumn: 1,
        endColumn: lineLength + 1,
    };
    return {
        name,
        kind,
        range,
        selectionRange: range,
        detail: '',
        children: [],
    };
}

// ─── Public registration ───────────────────────────────────────────────────────

/** @type {Array<{dispose: Function}>} */
let _disposables = [];
let _registered = false;
let _symbolProvider = null;
let _lastTokenizerFnCount = 0;
let _monaco = null;
let _validateAllFn = null;

/**
 * Register EcoLang with Monaco. Safe to call multiple times — subsequent
 * calls update the tokenizer and reconnect the symbol provider.
 *
 * @param {object} monaco  The global monaco namespace
 * @param {{ symbolProvider?: () => Array }} [options]
 *   symbolProvider: callback returning current workspace symbols
 */
export function registerEcoLang(monaco, { symbolProvider } = {}) {
    _monaco = monaco;
    if (symbolProvider) _symbolProvider = symbolProvider;

    // Collect function names for Monarch tokenizer
    const functionNames = [...FUNCTIONS_BY_NAME.keys()];
    _lastTokenizerFnCount = functionNames.length;

    if (!_registered) {
        _registered = true;

        monaco.languages.register({
            id: ECOLANG_ID,
            extensions: ['.model', '.scenario', '.edf', '.test'],
            aliases: ['EcoLang', 'ecolang'],
        });
        monaco.languages.setLanguageConfiguration(ECOLANG_ID, LANGUAGE_CONF);
    }

    // Always refresh the tokenizer (function list may have grown)
    monaco.languages.setMonarchTokensProvider(ECOLANG_ID, buildMonarchTokenizer(functionNames));

    // Dispose previous providers
    for (const d of _disposables) d.dispose?.();
    _disposables = [];

    // Register all providers
    _disposables.push(
        monaco.languages.registerCompletionItemProvider(
            ECOLANG_ID, createCompletionProvider(monaco, _symbolProvider)
        )
    );

    _disposables.push(
        monaco.languages.registerSignatureHelpProvider(
            ECOLANG_ID, createSignatureHelpProvider(monaco)
        )
    );

    _disposables.push(
        monaco.languages.registerHoverProvider(
            ECOLANG_ID, createHoverProvider(monaco, _symbolProvider)
        )
    );

    _disposables.push(
        monaco.languages.registerDocumentSymbolProvider(
            ECOLANG_ID, createDocumentSymbolProvider(monaco)
        )
    );

    _disposables.push(
        setupDiagnostics(monaco, _symbolProvider)
    );
}

/**
 * Update the symbol provider callback. Re-registers all providers with the new source.
 * Call this when the NotebookSymbolIndex changes its onChange callback.
 */
export function setEcoLangSymbolProvider(monaco, symbolProvider) {
    _symbolProvider = symbolProvider;
    // Diagnostics and completions will pick up the new provider on next invocation
    // (they call symbolProvider() dynamically). No need to re-register.
}

/**
 * Force a re-validation of all open EcoLang models (e.g. after symbol index rebuild).
 */
export function refreshEcoLangDiagnostics() {
    _validateAllFn?.();
}
