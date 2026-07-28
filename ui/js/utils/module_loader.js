/**
 * Module Loader
 *
 * Loads .esmp modules from the modules directory and registers them
 * with the ModuleRegistry. Called during application bootstrap.
 */

import { parseESMP, serializeToESMP } from './esmp_parser.js';
import { getModuleRegistry } from './module_registry.js';
import { getSetting } from '../core/settings.js';

/**
 * Get the host bridge API for module operations.
 * @returns {Object|null}
 */
function getHostBridge() {
    return typeof window !== 'undefined' ? window.pywebview?.api : null;
}

/**
 * Load all user modules from the modules directory.
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {Object} [options.eventBus] - Event bus for emitting updates
 * @param {boolean} [options.autoCreateDefaults=true] - Create default modules if missing
 * @returns {Promise<{ ok: boolean, loaded: string[], errors: string[] }>}
 */
export async function loadUserModules({ logger = null, eventBus = null, autoCreateDefaults = true } = {}) {
    const api = getHostBridge();
    if (!api) {
        logger?.warn?.('module-loader', 'Host bridge not available, skipping module loading');
        return { ok: false, loaded: [], errors: ['Host bridge not available'] };
    }

    const loaded = [];
    const errors = [];

    try {
        // Ensure default modules exist if configured
        if (autoCreateDefaults && getSetting('modules.autoCreateDefaults', true)) {
            logger?.debug?.('module-loader', 'Ensuring default modules exist...');
            const ensureResult = await api.module_ensure_defaults();
            if (ensureResult.ok && ensureResult.created?.length > 0) {
                logger?.info?.('module-loader', `Created default modules: ${ensureResult.created.join(', ')}`);
            }
        }

        // List available modules
        const listResult = await api.module_list_all();
        if (!listResult.ok) {
            errors.push(`Failed to list modules: ${listResult.error}`);
            return { ok: false, loaded, errors };
        }

        const modules = listResult.modules || [];
        logger?.info?.('module-loader', `Found ${modules.length} module(s)`);

        // Load and parse each module
        const registry = getModuleRegistry();
        for (const moduleInfo of modules) {
            try {
                logger?.debug?.('module-loader', `Loading ${moduleInfo.filename}...`);

                const loadResult = await api.module_load(moduleInfo.filename);
                if (!loadResult.ok) {
                    errors.push(`Failed to load ${moduleInfo.filename}: ${loadResult.error}`);
                    continue;
                }

                // Parse the ESMP content
                const parseResult = parseESMP(loadResult.content);
                if (!parseResult.ok) {
                    errors.push(`Failed to parse ${moduleInfo.filename}: ${parseResult.error}`);
                    continue;
                }

                // Register the module
                registry.registerModule(parseResult.module);
                loaded.push(parseResult.module.name);
                logger?.info?.('module-loader', `Loaded module: ${parseResult.module.name}`);

            } catch (err) {
                errors.push(`Error processing ${moduleInfo.filename}: ${err.message}`);
                logger?.error?.('module-loader', `Error loading ${moduleInfo.filename}`, err);
            }
        }

        // Emit module events so UI can refresh and function nodes re-validate
        if (loaded.length > 0 && eventBus?.emit) {
            eventBus.emit('modules:updated');
            eventBus.emit('modules:registry:changed');
            logger?.debug?.('module-loader', 'Emitted modules:updated + modules:registry:changed events');
        }

        return { ok: errors.length === 0, loaded, errors };

    } catch (err) {
        errors.push(`Module loading failed: ${err.message}`);
        logger?.error?.('module-loader', 'Module loading failed', err);
        return { ok: false, loaded, errors };
    }
}

/**
 * Save a module to the modules directory as an .esmp file.
 * @param {Object} module - Module definition from ModuleRegistry
 * @param {Object} [options]
 * @param {Object} [options.logger] - Logger instance
 * @returns {Promise<{ ok: boolean, path?: string, error?: string }>}
 */
export async function saveUserModule(module, { logger = null } = {}) {
    const api = getHostBridge();
    if (!api) {
        return { ok: false, error: 'Host bridge not available' };
    }

    try {
        // Serialize the module to ESMP format
        const content = serializeToESMP(module);

        // Save to modules directory
        const filename = `${module.name}.esmp`;
        const result = await api.module_save(filename, content);

        if (result.ok) {
            logger?.info?.('module-loader', `Saved module: ${filename}`);
        }

        return result;

    } catch (err) {
        logger?.error?.('module-loader', `Failed to save module: ${module.name}`, err);
        return { ok: false, error: err.message };
    }
}

/**
 * Delete a module's .esmp file from the modules directory.
 * @param {string} moduleName - Name of the module to delete
 * @param {Object} [options]
 * @param {Object} [options.logger] - Logger instance
 * @returns {Promise<{ ok: boolean, path?: string, error?: string }>}
 */
export async function deleteUserModule(moduleName, { logger = null } = {}) {
    const api = getHostBridge();
    if (!api) {
        return { ok: false, error: 'Host bridge not available' };
    }

    try {
        const filename = `${moduleName}.esmp`;
        const result = await api.module_delete(filename);

        if (result.ok) {
            logger?.info?.('module-loader', `Deleted module: ${filename}`);
        }

        return result;

    } catch (err) {
        logger?.error?.('module-loader', `Failed to delete module: ${moduleName}`, err);
        return { ok: false, error: err.message };
    }
}

/**
 * Get the modules directory path.
 * @returns {Promise<string|null>}
 */
export async function getModuleDirectory() {
    const api = getHostBridge();
    if (!api) {
        return null;
    }

    try {
        const result = await api.module_get_directory();
        return result.ok ? result.path : null;
    } catch {
        return null;
    }
}

/**
 * Reload all user modules (clear and re-load).
 * @param {Object} [options]
 * @param {Object} [options.logger] - Logger instance
 * @returns {Promise<{ ok: boolean, loaded: string[], errors: string[] }>}
 */
export async function reloadUserModules({ logger = null } = {}) {
    const registry = getModuleRegistry();

    // Clear existing addon modules
    const addonModules = registry.getModulesBySource('addon');
    for (const mod of addonModules) {
        registry.unregisterModule(mod.name);
    }

    return loadUserModules({ logger, autoCreateDefaults: false });
}
