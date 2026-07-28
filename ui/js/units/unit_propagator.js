/**
 * unit_propagator.js
 *
 * Walks an expression AST (from expression_parser.js) and infers the resulting
 * unit, producing diagnostics when units are incompatible.
 *
 * Design principles:
 *   - null (unspecified) is compatible with anything → graceful degradation
 *   - Diagnostics are warnings, never errors → units are advisory
 *   - All math/trig functions require dimensionless inputs
 *   - Addition/subtraction requires compatible units
 *   - Multiplication/division combine units algebraically
 */

import { AST } from './expression_parser.js';
import * as UnitEngine from './unit_engine.js';
import { getUnitRule } from './unit_rules.js';

/**
 * @typedef {Object} PropagationResult
 * @property {import('./unit_engine.js').Unit} unit - Inferred unit (null if unknown)
 * @property {Array<{ message: string, severity: 'warning'|'info' }>} diagnostics
 */

/**
 * @typedef {Object} PropagationContext
 * @property {function(string): import('./unit_engine.js').Unit} resolveVariable
 *   - Given an identifier name, return its unit (null if unknown)
 * @property {Object} [manifest] - Function manifest for unit rules
 */

/**
 * Propagate units through an expression AST.
 *
 * @param {Object} ast - AST root node from parseExpression()
 * @param {PropagationContext} context
 * @returns {PropagationResult}
 */
export function propagate(ast, context) {
    const diagnostics = [];
    const unit = _visit(ast, context, diagnostics);
    return { unit, diagnostics };
}

// ═══════════════════════════════════════════════════════════════════════════
// AST Visitor
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Visit an AST node and return its inferred unit.
 * @param {Object} node
 * @param {PropagationContext} ctx
 * @param {Array} diags
 * @returns {import('./unit_engine.js').Unit}
 */
function _visit(node, ctx, diags) {
    if (!node) return null;

    switch (node.type) {
        case AST.NUMBER:
            return _visitNumber(node);
        case AST.IDENTIFIER:
            return _visitIdentifier(node, ctx);
        case AST.BINARY:
            return _visitBinary(node, ctx, diags);
        case AST.UNARY:
            return _visitUnary(node, ctx, diags);
        case AST.CALL:
            return _visitCall(node, ctx, diags);
        case AST.CONDITIONAL:
            return _visitConditional(node, ctx, diags);
        default:
            return null;
    }
}

/**
 * Numbers are dimensionless.
 */
function _visitNumber(_node) {
    return {};
}

/**
 * Look up identifier unit from context.
 */
function _visitIdentifier(node, ctx) {
    // Built-in time variables
    if (node.name === 't' || node.name === 't0') {
        return UnitEngine.parse('time');
    }
    // Math constants are dimensionless
    if (node.name === 'pi' || node.name === 'PI' || node.name === 'e' || node.name === 'E') {
        return {};
    }
    return ctx.resolveVariable?.(node.name) ?? null;
}

/**
 * Binary operator unit rules:
 *   +, - : units must be compatible → warn if not; result = either unit
 *   *, % : units multiply
 *   /    : units divide
 *   ^, **: LHS unit raised to RHS power (RHS must be literal/dimensionless)
 *   ==, !=, <, >, <=, >= : comparison → dimensionless
 *   &&, || : logical → dimensionless
 */
function _visitBinary(node, ctx, diags) {
    const op = node.op;

    // Comparison and logical operators produce dimensionless result
    if (isComparisonOp(op) || isLogicalOp(op)) {
        _visit(node.left, ctx, diags);
        _visit(node.right, ctx, diags);
        return {};
    }

    const leftUnit = _visit(node.left, ctx, diags);
    const rightUnit = _visit(node.right, ctx, diags);

    switch (op) {
        case '+':
        case '-': {
            if (!UnitEngine.compatible(leftUnit, rightUnit)) {
                diags.push({
                    message: `Unit mismatch in ${op === '+' ? 'addition' : 'subtraction'}: `
                        + `${UnitEngine.format(leftUnit) || '?'} vs ${UnitEngine.format(rightUnit) || '?'}`,
                    severity: 'warning',
                });
            }
            // Return whichever is known (prefer left)
            return leftUnit ?? rightUnit;
        }

        case '*':
            return UnitEngine.multiply(leftUnit, rightUnit);

        case '/':
            return UnitEngine.divide(leftUnit, rightUnit);

        case '%':
            // Modulo preserves the unit of the left operand
            return leftUnit;

        case '^':
        case '**': {
            // Exponent must be a number literal or dimensionless
            if (rightUnit != null && !UnitEngine.isDimensionless(rightUnit)) {
                diags.push({
                    message: `Exponent should be dimensionless, got ${UnitEngine.format(rightUnit)}`,
                    severity: 'warning',
                });
            }
            // If right side is a literal number, we can compute the resulting unit
            if (node.right.type === AST.NUMBER && leftUnit != null) {
                return UnitEngine.power(leftUnit, node.right.value);
            }
            // Can't determine the resulting unit if exponent is non-literal
            if (leftUnit != null && Object.keys(leftUnit).length > 0) {
                return null; // Unknown result unit
            }
            // Dimensionless raised to anything is still dimensionless
            return leftUnit;
        }

        default:
            return null;
    }
}

/**
 * Unary operators preserve the unit.
 */
function _visitUnary(node, ctx, diags) {
    return _visit(node.operand, ctx, diags);
}

/**
 * Function call — apply unit rules from manifest.
 */
function _visitCall(node, ctx, diags) {
    const funcName = node.name;
    const argUnits = node.args.map(arg => _visit(arg, ctx, diags));
    const rule = getUnitRule(funcName, ctx.manifest);

    // Built-in abs/min/max (not in manifest but commonly used via SafeEval)
    if (!rule) {
        if (funcName === 'abs') return argUnits[0] ?? null;
        if (funcName === 'min' || funcName === 'max') return argUnits[0] ?? null;
        // Unknown function — no constraints
        return null;
    }

    switch (rule.type) {
        case 'sameAs': {
            const paramIdx = rule.param ?? 0;
            return argUnits[paramIdx] ?? null;
        }

        case 'power': {
            const baseUnit = argUnits[rule.base ?? 0];
            const exponent = rule.exponent ?? 1;
            if (baseUnit == null) return null;
            return UnitEngine.power(baseUnit, exponent);
        }

        case 'powerParam': {
            const baseUnit = argUnits[rule.base ?? 0];
            const expArg = node.args[rule.exponentParam ?? 1];
            if (baseUnit == null) return null;
            // Only compute if exponent is a literal number
            if (expArg?.type === AST.NUMBER) {
                const exp = rule.invertExponent ? (1 / expArg.value) : expArg.value;
                return UnitEngine.power(baseUnit, exp);
            }
            // Can't determine at parse time
            return null;
        }

        case 'requireDimensionless': {
            const checkParams = rule.params ?? [];
            for (const idx of checkParams) {
                const u = argUnits[idx];
                if (u != null && !UnitEngine.isDimensionless(u)) {
                    diags.push({
                        message: `${funcName}() expects dimensionless argument, got ${UnitEngine.format(u)}`,
                        severity: 'warning',
                    });
                }
            }
            return rule.result === 'dimensionless' ? {} : null;
        }

        case 'dimensionless':
            return {};

        case 'passthrough':
        default:
            return null;
    }
}

/**
 * Conditional: both branches should have compatible units.
 */
function _visitConditional(node, ctx, diags) {
    // Condition is evaluated for truthiness — don't constrain its unit
    _visit(node.condition, ctx, diags);

    const trueUnit = _visit(node.consequent, ctx, diags);
    const falseUnit = _visit(node.alternate, ctx, diags);

    if (!UnitEngine.compatible(trueUnit, falseUnit)) {
        diags.push({
            message: `Conditional branches have different units: `
                + `${UnitEngine.format(trueUnit) || '?'} vs ${UnitEngine.format(falseUnit) || '?'}`,
            severity: 'warning',
        });
    }

    return trueUnit ?? falseUnit;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function isComparisonOp(op) {
    return op === '==' || op === '!=' || op === '<' || op === '>'
        || op === '<=' || op === '>=';
}

function isLogicalOp(op) {
    return op === '&&' || op === '||';
}
