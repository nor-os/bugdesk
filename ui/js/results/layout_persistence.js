/**
 * layout_persistence.js
 *
 * Manages saving and loading tile layouts to localStorage per scenario.
 * Supports named dashboard configurations (multiple layouts per scenario).
 * Integrates with TemplateRegistry for automatic template resolution when
 * no saved layout exists for a scenario.
 */

import { TemplateRegistry } from './templates/template_registry.js';

const STORAGE_KEY = 'ecosim.results.layouts';
const CONFIGS_STORAGE_KEY = 'ecosim.results.configs';
const LAYOUT_VERSION = 3;

export class LayoutPersistence {
    constructor() {
        this._cache = null;
    }

    /**
     * Get layout for a specific scenario.
     * Falls back to template resolution when no saved layout exists.
     * @param {string} scenarioId - Scenario ID
     * @param {Object} [scenario] - Scenario object for template resolution (config.type, config.meta.tags)
     * @returns {Object} Layout object with tiles array
     */
    getLayout(scenarioId, scenario) {
        const all = this._loadAll();
        const layout = all[scenarioId];

        if (layout && layout.version === LAYOUT_VERSION) {
            return layout;
        }

        // Resolve a template based on scenario metadata
        const template = TemplateRegistry.resolve(scenario);
        if (template) {
            const instantiated = TemplateRegistry.instantiate(template);
            return {
                tiles: instantiated.tiles,
                version: LAYOUT_VERSION,
                templateId: instantiated.templateId,
                templateModified: false,
            };
        }

        // Final fallback: empty layout (should not happen — resolve always returns a default)
        return { tiles: [], version: LAYOUT_VERSION };
    }

    /**
     * Save layout for a specific scenario.
     * @param {string} scenarioId - Scenario ID
     * @param {Array|Object} layout - Layout array or object with tiles property
     */
    saveLayout(scenarioId, layout) {
        const all = this._loadAll();

        // Handle both array (from TileGrid.getLayout) and object (with tiles property) formats
        const tilesArray = Array.isArray(layout) ? layout : (layout?.tiles || []);

        all[scenarioId] = {
            tiles: tilesArray,
            version: LAYOUT_VERSION,
            updatedAt: Date.now(),
            templateId: layout?.templateId || all[scenarioId]?.templateId || null,
            templateModified: layout?.templateModified ?? true,
        };

        this._saveAll(all);
        window.logger?.nodes(`[LayoutPersistence] Saved layout for scenario ${scenarioId}`);
    }

    /**
     * Delete layout for a specific scenario.
     * @param {string} scenarioId - Scenario ID
     */
    deleteLayout(scenarioId) {
        const all = this._loadAll();

        if (all[scenarioId]) {
            delete all[scenarioId];
            this._saveAll(all);
            window.logger?.nodes(`[LayoutPersistence] Deleted layout for scenario ${scenarioId}`);
        }
    }

    /**
     * Reset layout by re-resolving and applying the best-matching template.
     * @param {string} scenarioId - Scenario ID
     * @param {Object} [scenario] - Scenario object for template resolution
     * @returns {Object} The resolved template layout
     */
    resetLayout(scenarioId, scenario) {
        const template = TemplateRegistry.resolve(scenario);
        const instantiated = TemplateRegistry.instantiate(template);
        const layout = {
            tiles: instantiated.tiles,
            version: LAYOUT_VERSION,
            templateId: instantiated.templateId,
            templateModified: false,
        };
        this.saveLayout(scenarioId, layout);
        return layout;
    }

    /**
     * Check if a scenario has a saved layout.
     * @param {string} scenarioId - Scenario ID
     * @returns {boolean}
     */
    hasLayout(scenarioId) {
        const all = this._loadAll();
        return !!all[scenarioId];
    }

    /**
     * Get all scenario IDs with saved layouts.
     * @returns {Array<string>}
     */
    getAllScenarioIds() {
        const all = this._loadAll();
        return Object.keys(all);
    }

    /**
     * Export all layouts as JSON string.
     * @returns {string}
     */
    exportAll() {
        const all = this._loadAll();
        return JSON.stringify(all, null, 2);
    }

    /**
     * Import layouts from JSON string.
     * @param {string} json - JSON string of layouts
     * @param {boolean} [merge=false] - Whether to merge with existing or replace
     */
    importAll(json, merge = false) {
        try {
            const imported = JSON.parse(json);

            if (merge) {
                const existing = this._loadAll();
                this._saveAll({ ...existing, ...imported });
            } else {
                this._saveAll(imported);
            }

            this._cache = null;
            window.logger?.nodes('[LayoutPersistence] Imported layouts');
        } catch (err) {
            console.error('[LayoutPersistence] Failed to import layouts:', err);
        }
    }

    /**
     * Clear all saved layouts.
     */
    clearAll() {
        try {
            localStorage.removeItem(STORAGE_KEY);
            this._cache = null;
            window.logger?.nodes('[LayoutPersistence] Cleared all layouts');
        } catch (err) {
            console.error('[LayoutPersistence] Failed to clear layouts:', err);
        }
    }

    /**
     * Load all layouts from storage.
     * @returns {Object}
     * @private
     */
    _loadAll() {
        if (this._cache) {
            return this._cache;
        }

        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                this._cache = JSON.parse(raw);
                return this._cache;
            }
        } catch (err) {
            console.error('[LayoutPersistence] Failed to load layouts:', err);
        }

        this._cache = {};
        return this._cache;
    }

    /**
     * Save all layouts to storage.
     * @param {Object} data
     * @private
     */
    _saveAll(data) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            this._cache = data;
        } catch (err) {
            console.error('[LayoutPersistence] Failed to save layouts:', err);

            // If quota exceeded, try to clear old entries
            if (err.name === 'QuotaExceededError') {
                this._pruneOldLayouts(data);
            }
        }
    }

    /**
     * Remove oldest layouts to free up space.
     * @param {Object} data
     * @private
     */
    _pruneOldLayouts(data) {
        const entries = Object.entries(data);

        // Sort by updatedAt, oldest first
        entries.sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));

        // Remove oldest 25%
        const removeCount = Math.ceil(entries.length * 0.25);
        for (let i = 0; i < removeCount; i++) {
            delete data[entries[i][0]];
        }

        // Try saving again
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            this._cache = data;
            window.logger?.warn('nodes', '[LayoutPersistence] Pruned old layouts due to quota');
        } catch (err) {
            console.error('[LayoutPersistence] Still cannot save after pruning:', err);
        }
    }

    /**
     * Get the template ID associated with a saved layout.
     * @param {string} scenarioId - Scenario ID
     * @returns {string|null} Template ID or null
     */
    getTemplateId(scenarioId) {
        const all = this._loadAll();
        return all[scenarioId]?.templateId || null;
    }

    /**
     * Check if the user has modified the layout since the template was applied.
     * @param {string} scenarioId - Scenario ID
     * @returns {boolean}
     */
    isTemplateModified(scenarioId) {
        const all = this._loadAll();
        return all[scenarioId]?.templateModified ?? false;
    }

    // =========================================================================
    // NAMED CONFIGURATION MANAGEMENT
    // =========================================================================

    /**
     * Get all saved configurations for a scenario.
     * @param {string} scenarioId - Scenario ID
     * @returns {Object} { activeId: string, configs: { id: { name, tiles, createdAt } } }
     */
    getConfigurations(scenarioId) {
        const all = this._loadConfigs();
        const scenarioConfigs = all[scenarioId];

        if (scenarioConfigs && Object.keys(scenarioConfigs.configs || {}).length > 0) {
            return scenarioConfigs;
        }

        // Return empty structure
        return {
            activeId: null,
            configs: {}
        };
    }

    /**
     * Save the current layout as a named configuration.
     * Names are enforced to be unique - duplicates get "(2)", "(3)", etc. suffix.
     * @param {string} scenarioId - Scenario ID
     * @param {string} name - Configuration name
     * @param {Array|Object} layout - Layout to save
     * @param {Object} [options] - Additional options
     * @param {string} [options.templateId] - Template ID that generated this layout
     * @returns {string} The new configuration ID
     */
    saveConfiguration(scenarioId, name, layout, options) {
        const all = this._loadConfigs();

        if (!all[scenarioId]) {
            all[scenarioId] = { activeId: null, configs: {} };
        }

        // Ensure unique name
        const uniqueName = this._getUniqueName(all[scenarioId].configs, name);

        const configId = `config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const tilesArray = Array.isArray(layout) ? layout : (layout?.tiles || []);

        all[scenarioId].configs[configId] = {
            name: uniqueName,
            tiles: tilesArray,
            version: LAYOUT_VERSION,
            createdAt: Date.now(),
            templateId: options?.templateId || null,
        };

        // Set as active if it's the first one
        if (!all[scenarioId].activeId) {
            all[scenarioId].activeId = configId;
        }

        this._saveConfigs(all);
        window.logger?.nodes(`[LayoutPersistence] Saved configuration "${uniqueName}" for scenario ${scenarioId}`);

        return configId;
    }

    /**
     * Generate a unique name by appending (2), (3), etc. if name already exists.
     * @param {Object} configs - Existing configurations object
     * @param {string} name - Desired name
     * @returns {string} Unique name
     * @private
     */
    _getUniqueName(configs, name) {
        if (!configs) return name;

        const existingNames = new Set(Object.values(configs).map(c => c.name));

        if (!existingNames.has(name)) {
            return name;
        }

        // Find next available number
        let counter = 2;
        let candidate = `${name} (${counter})`;
        while (existingNames.has(candidate)) {
            counter++;
            candidate = `${name} (${counter})`;
        }

        return candidate;
    }

    /**
     * Load a specific configuration.
     * @param {string} scenarioId - Scenario ID
     * @param {string} configId - Configuration ID
     * @returns {Object|null} Configuration layout or null if not found
     */
    loadConfiguration(scenarioId, configId) {
        const all = this._loadConfigs();
        const config = all[scenarioId]?.configs?.[configId];

        if (config) {
            // Update active config
            all[scenarioId].activeId = configId;
            this._saveConfigs(all);
            return config;
        }

        return null;
    }

    /**
     * Delete a saved configuration.
     * @param {string} scenarioId - Scenario ID
     * @param {string} configId - Configuration ID
     * @returns {boolean} True if deleted, false if not found
     */
    deleteConfiguration(scenarioId, configId) {
        const all = this._loadConfigs();

        if (!all[scenarioId]?.configs?.[configId]) {
            return false;
        }

        delete all[scenarioId].configs[configId];

        // Update active if deleted
        if (all[scenarioId].activeId === configId) {
            const remaining = Object.keys(all[scenarioId].configs);
            all[scenarioId].activeId = remaining.length > 0 ? remaining[0] : null;
        }

        this._saveConfigs(all);
        window.logger?.nodes(`[LayoutPersistence] Deleted configuration ${configId} for scenario ${scenarioId}`);

        return true;
    }

    /**
     * Update an existing configuration's layout (without creating a new ID).
     * @param {string} scenarioId - Scenario ID
     * @param {string} configId - Configuration ID
     * @param {Array|Object} layout - New layout to save
     * @returns {boolean} True if updated, false if not found
     */
    updateConfiguration(scenarioId, configId, layout) {
        const all = this._loadConfigs();

        if (!all[scenarioId]?.configs?.[configId]) {
            return false;
        }

        const tilesArray = Array.isArray(layout) ? layout : (layout?.tiles || []);

        all[scenarioId].configs[configId].tiles = tilesArray;
        all[scenarioId].configs[configId].version = LAYOUT_VERSION;
        all[scenarioId].configs[configId].updatedAt = Date.now();

        this._saveConfigs(all);
        return true;
    }

    /**
     * Update the templateId on an existing configuration.
     * @param {string} scenarioId - Scenario ID
     * @param {string} configId - Configuration ID
     * @param {string} templateId - New template ID
     * @returns {boolean} True if updated, false if not found
     */
    updateConfigurationTemplateId(scenarioId, configId, templateId) {
        const all = this._loadConfigs();

        if (!all[scenarioId]?.configs?.[configId]) {
            return false;
        }

        all[scenarioId].configs[configId].templateId = templateId;
        this._saveConfigs(all);
        return true;
    }

    /**
     * Rename a configuration.
     * Names are enforced to be unique - duplicates get "(2)", "(3)", etc. suffix.
     * @param {string} scenarioId - Scenario ID
     * @param {string} configId - Configuration ID
     * @param {string} newName - New name
     * @returns {string|false} The actual name used (may differ if duplicate), or false if not found
     */
    renameConfiguration(scenarioId, configId, newName) {
        const all = this._loadConfigs();

        if (!all[scenarioId]?.configs?.[configId]) {
            return false;
        }

        // Get configs excluding the one being renamed for uniqueness check
        const otherConfigs = {};
        Object.entries(all[scenarioId].configs).forEach(([id, config]) => {
            if (id !== configId) {
                otherConfigs[id] = config;
            }
        });

        const uniqueName = this._getUniqueName(otherConfigs, newName);
        all[scenarioId].configs[configId].name = uniqueName;
        this._saveConfigs(all);

        return uniqueName;
    }

    /**
     * Get the active configuration for a scenario.
     * @param {string} scenarioId - Scenario ID
     * @returns {Object|null} { id, name, tiles } or null
     */
    getActiveConfiguration(scenarioId) {
        const all = this._loadConfigs();
        const scenarioConfigs = all[scenarioId];

        if (!scenarioConfigs?.activeId) {
            return null;
        }

        const activeConfig = scenarioConfigs.configs[scenarioConfigs.activeId];
        if (activeConfig) {
            return {
                id: scenarioConfigs.activeId,
                ...activeConfig
            };
        }

        return null;
    }

    /**
     * Set the active configuration.
     * @param {string} scenarioId - Scenario ID
     * @param {string} configId - Configuration ID
     */
    setActiveConfiguration(scenarioId, configId) {
        const all = this._loadConfigs();

        if (all[scenarioId]?.configs?.[configId]) {
            all[scenarioId].activeId = configId;
            this._saveConfigs(all);
        }
    }

    /**
     * List all configurations for a scenario.
     * @param {string} scenarioId - Scenario ID
     * @returns {Array} Array of { id, name, createdAt, isActive }
     */
    listConfigurations(scenarioId) {
        const all = this._loadConfigs();
        const scenarioConfigs = all[scenarioId];

        if (!scenarioConfigs?.configs) {
            return [];
        }

        return Object.entries(scenarioConfigs.configs).map(([id, config]) => ({
            id,
            name: config.name,
            createdAt: config.createdAt,
            isActive: id === scenarioConfigs.activeId
        })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }

    /**
     * Get the template set fingerprint for a scenario.
     * Used to detect when templates have changed and configs need regeneration.
     * @param {string} scenarioId
     * @returns {string|null}
     */
    getTemplateSetId(scenarioId) {
        const all = this._loadConfigs();
        return all[scenarioId]?.templateSetId || null;
    }

    /**
     * Store the template set fingerprint for a scenario.
     * @param {string} scenarioId
     * @param {string} templateSetId
     */
    setTemplateSetId(scenarioId, templateSetId) {
        const all = this._loadConfigs();
        if (!all[scenarioId]) {
            all[scenarioId] = { activeId: null, configs: {} };
        }
        all[scenarioId].templateSetId = templateSetId;
        this._saveConfigs(all);
    }

    /**
     * Delete ALL configurations for a scenario.
     * @param {string} scenarioId
     */
    clearConfigurations(scenarioId) {
        const all = this._loadConfigs();
        delete all[scenarioId];
        this._saveConfigs(all);
    }

    /**
     * Load all configurations from storage.
     * @returns {Object}
     * @private
     */
    _loadConfigs() {
        try {
            const raw = localStorage.getItem(CONFIGS_STORAGE_KEY);
            if (raw) {
                return JSON.parse(raw);
            }
        } catch (err) {
            console.error('[LayoutPersistence] Failed to load configurations:', err);
        }
        return {};
    }

    /**
     * Save all configurations to storage.
     * @param {Object} data
     * @private
     */
    _saveConfigs(data) {
        try {
            localStorage.setItem(CONFIGS_STORAGE_KEY, JSON.stringify(data));
        } catch (err) {
            console.error('[LayoutPersistence] Failed to save configurations:', err);
        }
    }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton LayoutPersistence instance.
 * @returns {LayoutPersistence}
 */
export function getLayoutPersistence() {
    if (!instance) {
        instance = new LayoutPersistence();
    }
    return instance;
}

export default LayoutPersistence;
