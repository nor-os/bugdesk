/**
 * template_registry.js
 *
 * Registry for dashboard templates. Merges built-in and user-created templates,
 * provides lookup, catalog, and tag-based resolution for auto-applying templates
 * to scenarios.
 */

import { BUILTIN_TEMPLATES, TEMPLATE_CATEGORIES } from './template_manifest.js';

const USER_TEMPLATES_KEY = 'ecosim.dashboard.templates.user';

/** @type {Map<string, Object>} */
const registry = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register a template definition.
 * @param {Object} template - Template definition
 */
function register(template) {
    if (!template?.id) {
        console.warn('[TemplateRegistry] Template missing id:', template);
        return;
    }
    registry.set(template.id, template);
}

/**
 * Register all built-in templates.
 */
function registerBuiltins() {
    for (const template of BUILTIN_TEMPLATES) {
        register(template);
    }
}

/**
 * Load and register user-created templates from localStorage.
 */
function loadUserTemplates() {
    try {
        const raw = localStorage.getItem(USER_TEMPLATES_KEY);
        if (!raw) return;
        const templates = JSON.parse(raw);
        if (Array.isArray(templates)) {
            for (const template of templates) {
                register({ ...template, source: 'user' });
            }
        }
    } catch (err) {
        console.error('[TemplateRegistry] Failed to load user templates:', err);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a template by ID.
 * @param {string} id
 * @returns {Object|undefined}
 */
function get(id) {
    return registry.get(id);
}

/**
 * Check if a template exists.
 * @param {string} id
 * @returns {boolean}
 */
function has(id) {
    return registry.has(id);
}

/**
 * Get all registered templates.
 * @returns {Object[]}
 */
function getAll() {
    return Array.from(registry.values());
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog — for gallery display
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get template catalog grouped by category.
 * @param {Object} [options]
 * @param {string} [options.runType] - Filter by compatibility ('static' | 'monte-carlo')
 * @param {string} [options.search] - Search string to filter by name/description/tags
 * @returns {Array<{category: string, categoryMeta: Object, templates: Object[]}>}
 */
function getCatalog({ runType, search } = {}) {
    const searchLower = search?.toLowerCase().trim();

    // Group by category
    const groups = new Map();
    for (const template of registry.values()) {
        // Search filter
        if (searchLower) {
            const haystack = [
                template.name,
                template.description,
                ...(template.tags || []),
            ].join(' ').toLowerCase();
            if (!haystack.includes(searchLower)) continue;
        }

        const cat = template.category || 'general';
        if (!groups.has(cat)) {
            groups.set(cat, []);
        }
        groups.get(cat).push({
            ...template,
            compatible: !runType ||
                template.compatibility === runType ||
                template.compatibility === 'both',
        });
    }

    // Sort categories by order
    const sorted = Array.from(groups.entries())
        .map(([category, templates]) => ({
            category,
            categoryMeta: TEMPLATE_CATEGORIES[category] || {
                displayName: category,
                icon: 'widgets',
                order: 99,
            },
            templates,
        }))
        .sort((a, b) => a.categoryMeta.order - b.categoryMeta.order);

    return sorted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution — auto-match template to scenario
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the best-matching template for a scenario.
 *
 * Algorithm:
 *   1. Filter by run type compatibility
 *   2. Score = (matched tag count * 10) + priority
 *   3. Return highest-scoring template
 *   4. Fallback to default-static or default-mc
 *
 * @param {Object} scenario - Scenario object with config.type and config.meta.tags (or tags)
 * @returns {Object} Template definition (never null — always falls back to a default)
 */
function resolve(scenario) {
    const runType = scenario?.config?.type || scenario?.type || 'static';
    const scenarioTags = new Set(
        scenario?.config?.meta?.tags || scenario?.tags || []
    );

    let bestTemplate = null;
    let bestScore = -1;

    for (const template of registry.values()) {
        // Must be compatible with run type
        if (template.compatibility !== runType && template.compatibility !== 'both') {
            continue;
        }

        const recTags = template.recommendedFor?.tags || [];
        const priority = template.recommendedFor?.priority || 0;

        // Count matching tags
        let matchedTags = 0;
        for (const tag of recTags) {
            if (scenarioTags.has(tag)) matchedTags++;
        }

        const score = matchedTags * 10 + priority;

        if (score > bestScore) {
            bestScore = score;
            bestTemplate = template;
        }
    }

    // Fallback to defaults
    if (!bestTemplate) {
        bestTemplate = registry.get(
            runType === 'monte-carlo' ? 'default-mc' : 'default-static'
        );
    }

    return bestTemplate;
}

/**
 * Resolve ALL matching templates for a scenario.
 * Used to create multiple named dashboards per scenario.
 *
 * Algorithm:
 *   1. Filter by run type compatibility
 *   2. Require ALL recommendedFor.tags to be present in scenario tags
 *   3. Skip templates with empty recommendedFor.tags (generic defaults)
 *   4. Sort by priority descending
 *   5. Fallback: single default template if no specific matches
 *
 * @param {Object} scenario - Scenario object with config.type and config.meta.tags (or tags)
 * @returns {Object[]} Matching templates sorted by priority (never empty)
 */
function resolveAll(scenario) {
    const runType = scenario?.config?.type || scenario?.type || 'static';
    const scenarioTags = new Set(
        scenario?.config?.meta?.tags || scenario?.tags || []
    );

    const matches = [];

    for (const template of registry.values()) {
        if (template.compatibility !== runType && template.compatibility !== 'both') {
            continue;
        }

        const recTags = template.recommendedFor?.tags || [];
        if (recTags.length === 0) continue;

        const allMatch = recTags.every(tag => scenarioTags.has(tag));
        if (!allMatch) continue;

        matches.push(template);
    }

    matches.sort((a, b) =>
        (b.recommendedFor?.priority || 0) - (a.recommendedFor?.priority || 0)
    );

    if (matches.length > 0) return matches;

    const fallback = registry.get(
        runType === 'monte-carlo' ? 'default-mc' : 'default-static'
    );
    return fallback ? [fallback] : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Instantiation — clone a template into a usable layout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Instantiate a template into a layout with fresh tile IDs.
 * @param {Object} template - Template definition
 * @returns {Object} Layout object: { tiles, templateId, templateModified }
 */
function instantiate(template) {
    const timestamp = Date.now();
    return {
        tiles: template.tiles.map((tile, index) => ({
            ...tile,
            id: `${tile.type}-${timestamp}-${index}`,
            config: { ...tile.config },
        })),
        templateId: template.id,
        templateModified: false,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// User template CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save a user-created template.
 * @param {Object} template - Template definition (id will be auto-generated if missing)
 * @returns {string} The template ID
 */
function saveUserTemplate(template) {
    const id = template.id || `user-${Date.now()}`;
    const userTemplate = {
        ...template,
        id,
        source: 'user',
    };

    register(userTemplate);
    _persistUserTemplates();
    return id;
}

/**
 * Delete a user-created template.
 * @param {string} id - Template ID
 * @returns {boolean} True if deleted
 */
function deleteUserTemplate(id) {
    const template = registry.get(id);
    if (!template || template.source !== 'user') return false;

    registry.delete(id);
    _persistUserTemplates();
    return true;
}

/**
 * Rename a user-created template.
 * @param {string} id - Template ID
 * @param {string} newName - New name
 * @returns {boolean} True if renamed
 */
function renameUserTemplate(id, newName) {
    const template = registry.get(id);
    if (!template || template.source !== 'user') return false;

    // Templates are frozen for built-ins, but user templates are mutable
    const updated = { ...template, name: newName };
    registry.set(id, updated);
    _persistUserTemplates();
    return true;
}

/**
 * Get all user-created templates.
 * @returns {Object[]}
 */
function getUserTemplates() {
    return Array.from(registry.values()).filter(t => t.source === 'user');
}

/**
 * Persist all user templates to localStorage.
 * @private
 */
function _persistUserTemplates() {
    try {
        const userTemplates = getUserTemplates();
        localStorage.setItem(USER_TEMPLATES_KEY, JSON.stringify(userTemplates));
    } catch (err) {
        console.error('[TemplateRegistry] Failed to persist user templates:', err);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace template lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register templates shipped with a workspace.
 * Clears any previously registered workspace templates first (idempotent).
 * @param {Object[]} templates - Array of template definitions from workspace payload
 */
function registerWorkspaceTemplates(templates) {
    deregisterWorkspaceTemplates();
    if (!Array.isArray(templates) || templates.length === 0) return;
    for (const tmpl of templates) {
        register({ ...tmpl, source: 'workspace' });
    }
}

/**
 * Remove all workspace-source templates from the registry.
 */
function deregisterWorkspaceTemplates() {
    for (const [id, tmpl] of registry) {
        if (tmpl.source === 'workspace') registry.delete(id);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

registerBuiltins();
loadUserTemplates();

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export const TemplateRegistry = {
    register,
    get,
    has,
    getAll,
    getCatalog,
    resolve,
    resolveAll,
    instantiate,
    saveUserTemplate,
    deleteUserTemplate,
    renameUserTemplate,
    getUserTemplates,
    registerWorkspaceTemplates,
    deregisterWorkspaceTemplates,
    categories: TEMPLATE_CATEGORIES,
    _registry: registry,
};

export default TemplateRegistry;
