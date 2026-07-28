/**
 * expression_parser.js
 *
 * Lightweight Pratt parser for EcoLang expressions.
 * Produces a minimal AST used exclusively for unit/dimension inference.
 * Does NOT replace the backend parser or CodeMirror tokenizer.
 *
 * Supported syntax:
 *   - Numbers (int, float, scientific notation)
 *   - Identifiers (simple, qualified Namespace.var, stock refs Sector::Type[Account])
 *   - Binary ops: + - * / ^ ** %
 *   - Comparison: == != < > <= >=
 *   - Logical: && ||
 *   - Unary: - +
 *   - Parentheses
 *   - Function calls: func(arg, arg, ...)
 *   - Ternary: cond ? trueExpr : falseExpr
 */

// ═══════════════════════════════════════════════════════════════════════════
// Token types
// ═══════════════════════════════════════════════════════════════════════════

const T = Object.freeze({
    NUMBER: 'number',
    IDENT: 'ident',
    PLUS: '+',
    MINUS: '-',
    STAR: '*',
    SLASH: '/',
    PERCENT: '%',
    CARET: '^',
    DSTAR: '**',
    LPAREN: '(',
    RPAREN: ')',
    COMMA: ',',
    QUESTION: '?',
    COLON: ':',
    EQ: '==',
    NEQ: '!=',
    LT: '<',
    GT: '>',
    LTE: '<=',
    GTE: '>=',
    AND: '&&',
    OR: '||',
    EOF: 'eof',
});

// ═══════════════════════════════════════════════════════════════════════════
// AST node types
// ═══════════════════════════════════════════════════════════════════════════

export const AST = Object.freeze({
    NUMBER: 'Number',
    IDENTIFIER: 'Identifier',
    BINARY: 'Binary',
    UNARY: 'Unary',
    CALL: 'Call',
    CONDITIONAL: 'Conditional',
});

// ═══════════════════════════════════════════════════════════════════════════
// Tokenizer
// ═══════════════════════════════════════════════════════════════════════════

function tokenize(src) {
    const tokens = [];
    let i = 0;

    while (i < src.length) {
        const ch = src[i];

        // Whitespace
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            i++;
            continue;
        }

        // Comment (skip to end of line)
        if (ch === ';' || ch === '#') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }

        // Number (integer, float, scientific notation)
        if (ch >= '0' && ch <= '9') {
            const start = i;
            while (i < src.length && src[i] >= '0' && src[i] <= '9') i++;
            if (i < src.length && src[i] === '.') {
                i++;
                while (i < src.length && src[i] >= '0' && src[i] <= '9') i++;
            }
            // Scientific notation
            if (i < src.length && (src[i] === 'e' || src[i] === 'E')) {
                i++;
                if (i < src.length && (src[i] === '+' || src[i] === '-')) i++;
                while (i < src.length && src[i] >= '0' && src[i] <= '9') i++;
            }
            tokens.push({ type: T.NUMBER, value: parseFloat(src.slice(start, i)) });
            continue;
        }

        // Decimal starting with dot (e.g., .5)
        if (ch === '.' && i + 1 < src.length && src[i + 1] >= '0' && src[i + 1] <= '9') {
            const start = i;
            i++;
            while (i < src.length && src[i] >= '0' && src[i] <= '9') i++;
            if (i < src.length && (src[i] === 'e' || src[i] === 'E')) {
                i++;
                if (i < src.length && (src[i] === '+' || src[i] === '-')) i++;
                while (i < src.length && src[i] >= '0' && src[i] <= '9') i++;
            }
            tokens.push({ type: T.NUMBER, value: parseFloat(src.slice(start, i)) });
            continue;
        }

        // Identifier (including qualified names and stock references)
        if (isIdentStart(ch)) {
            const start = i;
            i++;
            while (i < src.length && isIdentContinue(src[i])) i++;

            // Check for qualified name: Namespace.Var or Sector::Type[Account]
            let ident = src.slice(start, i);

            // Handle :: (sector separator)
            while (i < src.length && src[i] === ':' && i + 1 < src.length && src[i + 1] === ':') {
                i += 2; // skip ::
                const partStart = i;
                while (i < src.length && isIdentContinue(src[i])) i++;
                ident += '::' + src.slice(partStart, i);
            }

            // Handle [AccountName]
            if (i < src.length && src[i] === '[') {
                const bracketStart = i;
                i++; // skip [
                while (i < src.length && src[i] !== ']') i++;
                if (i < src.length) i++; // skip ]
                ident += src.slice(bracketStart, i);
            }

            // Handle Namespace.Var (dot-qualified)
            if (i < src.length && src[i] === '.' && i + 1 < src.length && isIdentStart(src[i + 1])) {
                i++; // skip .
                const dotPartStart = i;
                while (i < src.length && isIdentContinue(src[i])) i++;
                let dotPart = src.slice(dotPartStart, i);

                // The dot part might also have :: and []
                while (i < src.length && src[i] === ':' && i + 1 < src.length && src[i + 1] === ':') {
                    i += 2;
                    const partStart = i;
                    while (i < src.length && isIdentContinue(src[i])) i++;
                    dotPart += '::' + src.slice(partStart, i);
                }
                if (i < src.length && src[i] === '[') {
                    const bracketStart = i;
                    i++;
                    while (i < src.length && src[i] !== ']') i++;
                    if (i < src.length) i++;
                    dotPart += src.slice(bracketStart, i);
                }

                ident += '.' + dotPart;
            }

            tokens.push({ type: T.IDENT, value: ident });
            continue;
        }

        // Two-character operators
        if (i + 1 < src.length) {
            const two = src.slice(i, i + 2);
            if (two === '**') { tokens.push({ type: T.DSTAR }); i += 2; continue; }
            if (two === '==') { tokens.push({ type: T.EQ }); i += 2; continue; }
            if (two === '!=') { tokens.push({ type: T.NEQ }); i += 2; continue; }
            if (two === '<=') { tokens.push({ type: T.LTE }); i += 2; continue; }
            if (two === '>=') { tokens.push({ type: T.GTE }); i += 2; continue; }
            if (two === '&&') { tokens.push({ type: T.AND }); i += 2; continue; }
            if (two === '||') { tokens.push({ type: T.OR }); i += 2; continue; }
        }

        // Single-character operators
        switch (ch) {
            case '+': tokens.push({ type: T.PLUS }); i++; continue;
            case '-': tokens.push({ type: T.MINUS }); i++; continue;
            case '*': tokens.push({ type: T.STAR }); i++; continue;
            case '/': tokens.push({ type: T.SLASH }); i++; continue;
            case '%': tokens.push({ type: T.PERCENT }); i++; continue;
            case '^': tokens.push({ type: T.CARET }); i++; continue;
            case '(': tokens.push({ type: T.LPAREN }); i++; continue;
            case ')': tokens.push({ type: T.RPAREN }); i++; continue;
            case ',': tokens.push({ type: T.COMMA }); i++; continue;
            case '?': tokens.push({ type: T.QUESTION }); i++; continue;
            case ':': tokens.push({ type: T.COLON }); i++; continue;
            case '<': tokens.push({ type: T.LT }); i++; continue;
            case '>': tokens.push({ type: T.GT }); i++; continue;
            case '=': tokens.push({ type: T.EQ }); i++; continue;
        }

        // String literals — skip (not relevant to unit analysis)
        if (ch === '"' || ch === "'") {
            const quote = ch;
            i++;
            while (i < src.length && src[i] !== quote) i++;
            if (i < src.length) i++; // skip closing quote
            tokens.push({ type: T.IDENT, value: '__string__' });
            continue;
        }

        // Unknown character — skip
        i++;
    }

    tokens.push({ type: T.EOF });
    return tokens;
}

function isIdentStart(ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentContinue(ch) {
    return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

// ═══════════════════════════════════════════════════════════════════════════
// Pratt Parser
// ═══════════════════════════════════════════════════════════════════════════

// Binding powers (precedence)
const BP = Object.freeze({
    NONE: 0,
    TERNARY: 1,
    OR: 2,
    AND: 3,
    COMPARISON: 4,
    SUM: 5,
    PRODUCT: 6,
    POWER: 7,
    UNARY: 8,
    CALL: 9,
});

function getInfixBP(type) {
    switch (type) {
        case T.QUESTION: return BP.TERNARY;
        case T.OR: return BP.OR;
        case T.AND: return BP.AND;
        case T.EQ: case T.NEQ:
        case T.LT: case T.GT:
        case T.LTE: case T.GTE: return BP.COMPARISON;
        case T.PLUS: case T.MINUS: return BP.SUM;
        case T.STAR: case T.SLASH: case T.PERCENT: return BP.PRODUCT;
        case T.CARET: case T.DSTAR: return BP.POWER;
        default: return BP.NONE;
    }
}

class Parser {
    constructor(tokens) {
        this.tokens = tokens;
        this.pos = 0;
    }

    peek() {
        return this.tokens[this.pos] ?? { type: T.EOF };
    }

    advance() {
        const t = this.tokens[this.pos];
        this.pos++;
        return t ?? { type: T.EOF };
    }

    expect(type) {
        const t = this.advance();
        if (t.type !== type) {
            throw new Error(`Expected ${type}, got ${t.type}`);
        }
        return t;
    }

    parse() {
        const expr = this.parseExpr(BP.NONE);
        return expr;
    }

    parseExpr(minBP) {
        let left = this.parsePrefix();

        while (true) {
            const token = this.peek();
            const bp = getInfixBP(token.type);
            if (bp <= minBP) break;

            // Ternary special case
            if (token.type === T.QUESTION) {
                this.advance(); // consume ?
                const trueExpr = this.parseExpr(BP.NONE);
                this.expect(T.COLON);
                const falseExpr = this.parseExpr(BP.TERNARY);
                left = { type: AST.CONDITIONAL, condition: left, consequent: trueExpr, alternate: falseExpr };
                continue;
            }

            this.advance(); // consume operator
            const op = token.type;

            // Right-associative for exponentiation
            const rightBP = (op === T.CARET || op === T.DSTAR) ? bp - 1 : bp;
            const right = this.parseExpr(rightBP);

            left = { type: AST.BINARY, op, left, right };
        }

        return left;
    }

    parsePrefix() {
        const token = this.peek();

        // Unary minus / plus
        if (token.type === T.MINUS || token.type === T.PLUS) {
            this.advance();
            const operand = this.parseExpr(BP.UNARY);
            return { type: AST.UNARY, op: token.type, operand };
        }

        // Number
        if (token.type === T.NUMBER) {
            this.advance();
            return { type: AST.NUMBER, value: token.value };
        }

        // Identifier or function call
        if (token.type === T.IDENT) {
            this.advance();
            const name = token.value;

            // Check for function call
            if (this.peek().type === T.LPAREN) {
                this.advance(); // consume (
                const args = [];
                while (this.peek().type !== T.RPAREN && this.peek().type !== T.EOF) {
                    // Skip keyword argument names (e.g., name='x')
                    if (this.peek().type === T.IDENT && this.pos + 1 < this.tokens.length && this.tokens[this.pos + 1]?.type === T.EQ) {
                        this.advance(); // skip kwarg name
                        this.advance(); // skip =
                    }
                    args.push(this.parseExpr(BP.NONE));
                    if (this.peek().type === T.COMMA) {
                        this.advance(); // consume ,
                    }
                }
                if (this.peek().type === T.RPAREN) this.advance();
                return { type: AST.CALL, name, args };
            }

            return { type: AST.IDENTIFIER, name };
        }

        // Parenthesized expression
        if (token.type === T.LPAREN) {
            this.advance();
            const expr = this.parseExpr(BP.NONE);
            if (this.peek().type === T.RPAREN) this.advance();
            return expr;
        }

        // Fallback for unexpected tokens — treat as a number 0
        this.advance();
        return { type: AST.NUMBER, value: 0 };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse an EcoLang expression string into a minimal AST.
 *
 * AST node shapes:
 *   { type: 'Number', value: number }
 *   { type: 'Identifier', name: string }
 *   { type: 'Binary', op: string, left: Node, right: Node }
 *   { type: 'Unary', op: string, operand: Node }
 *   { type: 'Call', name: string, args: Node[] }
 *   { type: 'Conditional', condition: Node, consequent: Node, alternate: Node }
 *
 * @param {string} expression - EcoLang expression string
 * @returns {Object} AST root node
 */
export function parseExpression(expression) {
    if (!expression || typeof expression !== 'string') {
        return { type: AST.NUMBER, value: 0 };
    }
    const trimmed = expression.trim();
    if (!trimmed) {
        return { type: AST.NUMBER, value: 0 };
    }
    const tokens = tokenize(trimmed);
    const parser = new Parser(tokens);
    return parser.parse();
}

/**
 * Collect all identifier names referenced in an AST.
 * @param {Object} node - AST root
 * @returns {Set<string>} Set of identifier names
 */
export function collectIdentifiers(node) {
    const ids = new Set();
    _walkIdentifiers(node, ids);
    return ids;
}

function _walkIdentifiers(node, ids) {
    if (!node) return;
    switch (node.type) {
        case AST.IDENTIFIER:
            ids.add(node.name);
            break;
        case AST.BINARY:
            _walkIdentifiers(node.left, ids);
            _walkIdentifiers(node.right, ids);
            break;
        case AST.UNARY:
            _walkIdentifiers(node.operand, ids);
            break;
        case AST.CALL:
            node.args.forEach(a => _walkIdentifiers(a, ids));
            break;
        case AST.CONDITIONAL:
            _walkIdentifiers(node.condition, ids);
            _walkIdentifiers(node.consequent, ids);
            _walkIdentifiers(node.alternate, ids);
            break;
    }
}
