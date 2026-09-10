import globals from 'globals';

/**
 * Lint config for a UI with NO BUILD STEP.
 *
 * WHY THIS EXISTS. `ui/` is ES modules served straight off disk through an
 * import map — nothing ever compiles them, so the first thing that notices a
 * name which is used but never imported is the browser, at the moment the line
 * runs. That is exactly how the top-nav highlight broke: an edit added a call to
 * `activeTopNavKind(wm)` but the matching import never landed, and the only
 * symptom was a chip that quietly stopped lighting up.
 *
 * `scripts/check-graph.mjs` verifies that every import RESOLVES and that every
 * named import is really exported. It cannot see the opposite mistake — a name
 * used with no import at all — because there is nothing to resolve. `no-undef`
 * is precisely that check, so it is the one rule this config is really here for.
 *
 * The rule set is deliberately small. `ui/js/` is a large tree inherited from
 * EcoAgent and a full style ruleset would bury the two or three rules that
 * actually catch bugs under thousands of formatting opinions nobody is going to
 * act on. Everything here is a real defect, not a preference.
 */
export default [
    {
        files: ['**/*.js', '**/*.mjs'],
        ignores: ['ui/vendor/**', 'node_modules/**', 'server/**'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                // Set by index.html before the shell boots, and by install.js
                // after the WM is built. Both are read across the tree.
                __BUGDESK_CONFIG__: 'readonly',
                __ECOAGENT_DEBUG__: 'readonly',
                __twm: 'readonly',
                pywebview: 'readonly',
                // Vendored libraries loaded by <script> tags, not imported.
                Plotly: 'readonly',
                katex: 'readonly',
                monaco: 'readonly',
                require: 'readonly',
            },
        },
        rules: {
            // THE rule. A name used but never imported or declared.
            'no-undef': 'error',
            // The temporal dead zone — but only ADVISORY here. The rule cannot
            // tell a genuine init-time read from a closure that merely mentions
            // a `const` declared further down, and this codebase is full of the
            // latter (a `refresh()` helper written above the `table` it drives).
            // Every one of the 47 it currently reports is that pattern, so as an
            // error it would bury `no-undef` rather than guard anything.
            'no-use-before-define': ['warn', { functions: false, classes: false, variables: true }],
            // An import that no longer has a reader is dead weight; an unused
            // local is usually the leftover half of an edit.
            'no-unused-vars': ['warn', {
                args: 'none',
                caughtErrors: 'none',
                varsIgnorePattern: '^_',
            }],
            'no-dupe-keys': 'error',
            'no-dupe-class-members': 'error',
            'no-unsafe-negation': 'error',
            'no-unreachable': 'error',
            'no-constant-condition': ['error', { checkLoops: false }],
        },
    },
    {
        // Node-side tooling.
        files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: { 'no-undef': 'error' },
    },
];
