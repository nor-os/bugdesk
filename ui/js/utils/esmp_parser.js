/**
 * ESMP (EcoSim Module Plain text) Parser
 *
 * Parses .esmp files in DSL format into module definitions compatible
 * with the ModuleRegistry.
 *
 * DSL Format:
 * -----------
 * .MODULE ModuleName
 * .DESCRIPTION Optional module description
 * .READONLY              ; Optional: marks module as read-only (cannot be edited)
 *
 * ; Comments start with semicolon
 *
 * functionName param1 param2 =
 *     local_var = expression
 *     return expression
 *
 * .END MODULE
 */

/**
 * Parse an ESMP file content into a module definition.
 * @param {string} content - The ESMP file content
 * @returns {{ ok: boolean, module?: Object, error?: string }}
 */
export function parseESMP(content) {
    if (!content || typeof content !== 'string') {
        return { ok: false, error: 'Empty or invalid content' };
    }

    try {
        const lines = content.split(/\r?\n/);
        let moduleName = null;
        let description = null;
        let readonly = false;
        const functions = {};
        let currentFunction = null;
        let currentBody = [];
        let inModule = false;

        for (let i = 0; i < lines.length; i++) {
            const lineNum = i + 1;
            const rawLine = lines[i];
            const line = rawLine.trim();

            // Skip empty lines and comments
            if (!line || line.startsWith(';')) {
                continue;
            }

            // Module start directive
            if (line.startsWith('.MODULE ')) {
                if (inModule) {
                    return { ok: false, error: `Line ${lineNum}: Nested .MODULE not allowed` };
                }
                moduleName = line.substring(8).trim();
                if (!moduleName) {
                    return { ok: false, error: `Line ${lineNum}: Module name required` };
                }
                inModule = true;
                continue;
            }

            // Module description directive
            if (line.startsWith('.DESCRIPTION ')) {
                if (!inModule) {
                    return { ok: false, error: `Line ${lineNum}: .DESCRIPTION must be inside .MODULE` };
                }
                description = line.substring(13).trim();
                continue;
            }

            // Readonly directive
            if (line === '.READONLY') {
                if (!inModule) {
                    return { ok: false, error: `Line ${lineNum}: .READONLY must be inside .MODULE` };
                }
                readonly = true;
                continue;
            }

            // Module end directive
            if (line === '.END MODULE') {
                if (!inModule) {
                    return { ok: false, error: `Line ${lineNum}: .END MODULE without .MODULE` };
                }
                // Finalize any pending function
                if (currentFunction) {
                    finishFunction(functions, currentFunction, currentBody);
                    currentFunction = null;
                    currentBody = [];
                }
                inModule = false;
                continue;
            }

            // Skip lines outside of module
            if (!inModule) {
                continue;
            }

            // Check if this is a function definition line (name params =)
            const funcMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+(.*?)\s*=\s*$/);
            if (funcMatch) {
                // Finalize previous function if any
                if (currentFunction) {
                    finishFunction(functions, currentFunction, currentBody);
                }

                const fnName = funcMatch[1];
                const paramsStr = funcMatch[2].trim();
                const params = paramsStr ? paramsStr.split(/\s+/) : [];

                currentFunction = {
                    name: fnName,
                    params: params,
                    description: extractPrecedingComment(lines, i),
                };
                currentBody = [];
                continue;
            }

            // Check if this is a continuation of function body (indented line)
            if (currentFunction && (rawLine.startsWith('    ') || rawLine.startsWith('\t'))) {
                currentBody.push(line);
                continue;
            }

            // If we have a current function and this is not indented, it might be a single-line function
            // or an error. For robustness, treat unindented non-directive lines as ending the current function
            if (currentFunction) {
                finishFunction(functions, currentFunction, currentBody);
                currentFunction = null;
                currentBody = [];
            }
        }

        // Finalize any remaining function
        if (currentFunction) {
            finishFunction(functions, currentFunction, currentBody);
        }

        if (!moduleName) {
            return { ok: false, error: 'No .MODULE directive found' };
        }

        return {
            ok: true,
            module: {
                name: moduleName,
                source: 'addon', // Loaded from addon directory
                description: description,
                functions: functions,
                parameters: {},
                readonly: readonly,
            },
        };
    } catch (error) {
        return { ok: false, error: `Parse error: ${error.message}` };
    }
}

/**
 * Extract the preceding comment block as function description.
 * @param {string[]} lines - All lines
 * @param {number} funcLineIndex - Index of function definition line
 * @returns {string|null}
 */
function extractPrecedingComment(lines, funcLineIndex) {
    const comments = [];
    let i = funcLineIndex - 1;

    // Walk backwards collecting comment lines
    while (i >= 0) {
        const line = lines[i].trim();
        if (line.startsWith(';')) {
            // Remove the semicolon and leading space
            const comment = line.substring(1).trim();
            comments.unshift(comment);
            i--;
        } else if (line === '') {
            // Allow blank lines in comment block
            i--;
        } else {
            // Hit non-comment content
            break;
        }
    }

    return comments.length > 0 ? comments.join(' ') : null;
}

/**
 * Finalize a function definition and add it to the functions object.
 * @param {Object} functions - Functions object to add to
 * @param {Object} funcDef - Function definition { name, params, description }
 * @param {string[]} bodyLines - Body lines (declarations and return)
 */
function finishFunction(functions, funcDef, bodyLines) {
    // Build the expression from body lines
    // The body typically contains local variable assignments and a return statement
    let expression = '';

    if (bodyLines.length === 0) {
        // No body - empty function
        expression = '';
    } else if (bodyLines.length === 1) {
        // Single line - might be just a return or direct expression
        const line = bodyLines[0];
        if (line.startsWith('return ')) {
            expression = line.substring(7).trim();
        } else {
            expression = line;
        }
    } else {
        // Multiple lines - reconstruct the expression
        // Join with newlines, preserving the multiline structure
        expression = bodyLines.join('\n');
    }

    functions[funcDef.name] = {
        name: funcDef.name,
        params: funcDef.params,
        expression: expression,
        moduleName: null, // Will be set by registry
        signature: `${funcDef.name}(${funcDef.params.join(', ')})`,
        description: funcDef.description,
    };
}

/**
 * Serialize a module definition to ESMP DSL format.
 * @param {Object} module - Module definition from ModuleRegistry
 * @returns {string} ESMP file content
 */
export function serializeToESMP(module) {
    if (!module || !module.name) {
        throw new Error('Invalid module: name required');
    }

    const lines = [];

    // Module header
    lines.push(`.MODULE ${module.name}`);
    if (module.description) {
        lines.push(`.DESCRIPTION ${module.description}`);
    }
    if (module.readonly) {
        lines.push('.READONLY');
    }
    lines.push('');

    // Functions
    const functions = module.functions || {};
    for (const [fnName, fn] of Object.entries(functions)) {
        // Add description as comment
        if (fn.description) {
            lines.push(`; ${fn.description}`);
        }

        // Function signature
        const params = (fn.params || []).join(' ');
        lines.push(`${fnName} ${params} =`);

        // Function body
        const expression = fn.expression || '';
        const bodyLines = expression.split('\n');
        for (const bodyLine of bodyLines) {
            lines.push(`    ${bodyLine}`);
        }

        lines.push('');
    }

    // Module footer
    lines.push('.END MODULE');

    return lines.join('\n');
}

/**
 * Validate ESMP content without fully parsing.
 * @param {string} content - ESMP content
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateESMP(content) {
    const result = parseESMP(content);
    if (result.ok) {
        return { valid: true, errors: [] };
    }
    return { valid: false, errors: [result.error] };
}
