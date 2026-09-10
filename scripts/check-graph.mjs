/**
 * check-graph.mjs — walk the ES module graph `ui/index.html` actually loads and
 * verify that:
 *   1. every import specifier resolves to a file that exists
 *   2. every NAMED import is really exported by the module it comes from
 *
 * `ui/` has no build step: the modules are served straight off disk through an
 * import map, so nothing ever compiles them and the first thing to notice a bad
 * import is the browser, at the moment the line runs.
 *
 * The complementary check is `no-undef` in eslint.config.mjs — a name used with
 * NO import at all, which this script cannot see because there is nothing to
 * resolve. Run both (`npm test`).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UI = join(ROOT, 'ui');

// Mirrors ui/index.html's import map.
const IMPORT_MAP = {
    '@flexdesk/core': `${UI}/vendor/flexdesk/core.js`,
    '@flexdesk/host': `${UI}/vendor/flexdesk/host.js`,
    '@flexdesk/wm': `${UI}/vendor/flexdesk/wm.js`,
    '@codemirror/state': `${UI}/vendor/codemirror/state.js`,
    '@codemirror/view': `${UI}/vendor/codemirror/view.js`,
    '@codemirror/commands': `${UI}/vendor/codemirror/commands.js`,
    '@codemirror/language': `${UI}/vendor/codemirror/language.js`,
    '@codemirror/autocomplete': `${UI}/vendor/codemirror/autocomplete.js`,
    '@codemirror/search': `${UI}/vendor/codemirror/search.js`,
    '@codemirror/lint': `${UI}/vendor/codemirror/lint.js`,
    '@lezer/common': `${UI}/vendor/lezer/common.js`,
    '@lezer/highlight': `${UI}/vendor/lezer/highlight.js`,
    '@lezer/lr': `${UI}/vendor/lezer/lr.js`,
    crelt: `${UI}/vendor/crelt.js`,
    'style-mod': `${UI}/vendor/style-mod.js`,
    'w3c-keyname': `${UI}/vendor/w3c-keyname.js`,
};

const ENTRIES = [
    `${UI}/js/bootstrap/app_bootstrap.js`,
    `${UI}/js/ticketdesk/first_run.js`,
    `${UI}/js/tiling/install.js`,
];

const IMPORT_RE =
    /(?:^|[\s;}])import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|export\s+(?:\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/g;

const problems = [];
const seen = new Set();
const exportCache = new Map();

/** Named exports of a module, good enough for hand-written source. */
function exportsOf(file) {
    if (exportCache.has(file)) return exportCache.get(file);
    const names = new Set();
    let src = '';
    try { src = readFileSync(file, 'utf8'); } catch { exportCache.set(file, names); return names; }

    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
        names.add(m[1]);
    }
    for (const m of src.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
        for (const part of m[1].split(',')) {
            const as = part.split(/\s+as\s+/);
            const name = (as[1] ?? as[0]).trim();
            if (name) names.add(name);
        }
    }
    // `export { a, b } from './x'` and `export * from './x'` re-export.
    for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
        for (const part of m[1].split(',')) {
            const as = part.split(/\s+as\s+/);
            const name = (as[1] ?? as[0]).trim();
            if (name) names.add(name);
        }
    }
    // `export const { a, b } = obj` — a destructuring export. Real, and the
    // pattern the bound filter models use.
    for (const m of src.matchAll(/export\s+(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
        for (const part of m[1].split(',')) {
            const as = part.split(/\s*:\s*/);
            const name = (as[1] ?? as[0]).trim();
            if (name) names.add(name);
        }
    }
    if (/export\s+\*\s+from/.test(src)) names.add('*STAR*');
    if (/export\s+default/.test(src)) names.add('default');
    exportCache.set(file, names);
    return names;
}

/** Remove block and line comments. Good enough: no regex literal or string in
 *  this codebase contains an unbalanced comment opener. */
function strip(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

function resolveSpec(spec, fromFile) {
    if (IMPORT_MAP[spec]) return IMPORT_MAP[spec];
    if (spec.startsWith('.')) return resolve(dirname(fromFile), spec);
    return null; // bare specifier with no map entry
}

function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    let src;
    try { src = readFileSync(file, 'utf8'); }
    catch { problems.push(`MISSING FILE: ${relative(UI, file)}`); return; }
    // Doc comments in this codebase show usage examples that are literally
    // `import { x } from './y.js'`. Strip comments first or every one of them
    // is reported as a broken import.
    src = strip(src);

    for (const m of src.matchAll(IMPORT_RE)) {
        const clause = m[1];
        const spec = m[2] ?? m[3] ?? m[4];
        if (!spec) continue;
        const target = resolveSpec(spec, file);
        if (!target) {
            problems.push(`${relative(UI, file)}: bare specifier "${spec}" is not in the import map`);
            continue;
        }
        if (!existsSync(target)) {
            problems.push(`${relative(UI, file)}: imports "${spec}" -> ${relative(UI, target)} (does not exist)`);
            continue;
        }
        // Named imports: `{ a, b as c }`, possibly after a default binding.
        if (clause && clause.includes('{')) {
            const inner = clause.slice(clause.indexOf('{') + 1, clause.lastIndexOf('}'));
            const available = exportsOf(target);
            if (!available.has('*STAR*')) {
                for (const part of inner.split(',')) {
                    const name = part.split(/\s+as\s+/)[0].trim();
                    if (!name) continue;
                    if (!available.has(name)) {
                        problems.push(`${relative(UI, file)}: imports { ${name} } from "${spec}" — not exported there`);
                    }
                }
            }
        }
        walk(target);
    }
}

for (const e of ENTRIES) walk(e);

console.log(`walked ${seen.size} modules from ${ENTRIES.length} entry points`);
if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error('  ' + p);
    process.exit(1);
}
console.log('OK: every import resolves and every named import is exported.');
