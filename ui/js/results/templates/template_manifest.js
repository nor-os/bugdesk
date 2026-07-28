/**
 * template_manifest.js
 *
 * Built-in dashboard template definitions and category metadata.
 * Templates are model-agnostic entities that declare compatibility with
 * run types (static / monte-carlo) and use tags for auto-matching to scenarios.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Categories — model-agnostic, describe analytical purpose
// ─────────────────────────────────────────────────────────────────────────────

export const TEMPLATE_CATEGORIES = Object.freeze({
    general: {
        displayName: 'General',
        icon: 'dashboard',
        order: 1,
    },
    deterministic: {
        displayName: 'Deterministic Analysis',
        icon: 'timeline',
        order: 2,
    },
    uncertainty: {
        displayName: 'Uncertainty Analysis',
        icon: 'casino',
        order: 3,
    },
    accounting: {
        displayName: 'Accounting / SFC',
        icon: 'account_balance',
        order: 4,
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Built-in templates
// ─────────────────────────────────────────────────────────────────────────────

export const BUILTIN_TEMPLATES = Object.freeze([

    // ── General defaults ─────────────────────────────────────────────────────

    {
        id: 'default-static',
        name: 'Default Overview',
        description: 'General-purpose dashboard for deterministic simulation runs.',
        icon: 'dashboard',
        category: 'general',
        compatibility: 'static',
        source: 'builtin',
        tags: ['default', 'overview', 'static'],
        recommendedFor: {
            tags: [],
            priority: 1,
        },
        tiles: [
            { type: 'fan-chart',                x: 0, y: 0, w: 6, h: 4, config: { variable: null } },
            { type: 'statistics-table',          x: 6, y: 0, w: 6, h: 4, config: {} },
            { type: 'phase-plot',                x: 0, y: 4, w: 6, h: 4, config: {} },
            { type: 'stock-flow-decomposition',  x: 6, y: 4, w: 6, h: 3, config: {} },
        ],
        demoDataProfile: 'generic-static',
    },

    {
        id: 'default-mc',
        name: 'Default MC Overview',
        description: 'General-purpose dashboard for Monte Carlo simulation runs.',
        icon: 'casino',
        category: 'general',
        compatibility: 'monte-carlo',
        source: 'builtin',
        tags: ['default', 'overview', 'monte-carlo'],
        recommendedFor: {
            tags: [],
            priority: 1,
        },
        tiles: [
            { type: 'fan-chart',               x: 0, y: 0, w: 6, h: 4, config: { variable: null } },
            { type: 'statistics-table',         x: 6, y: 0, w: 6, h: 4, config: {} },
            { type: 'tornado-diagram',          x: 0, y: 4, w: 6, h: 4, config: {} },
            { type: 'distribution-histogram',   x: 6, y: 4, w: 3, h: 3, config: { variable: null } },
            { type: 'convergence-diagnostic',   x: 9, y: 4, w: 3, h: 3, config: {} },
        ],
        demoDataProfile: 'generic-mc',
    },
]);
