/**
 * ETL Plugin Registry
 *
 * Registry for ETL plugin definitions, populated during bootstrap.
 * The ETL manifest queries this to include plugin-loaded ETL source providers
 * alongside built-in ETL node definitions.
 *
 * For plugins that lack a JavaScript `describeConfig()` method, this module
 * auto-generates one from the JSON config schema in `node_def.json`.
 */

import { ConfigDescriptors } from '../nodes/config_descriptors.js';

/** @type {Map<string, Object>} */
const _etlPluginDefs = new Map();

/**
 * Register an ETL plugin definition.
 * @param {string} type - Node type (e.g., "etl-source-worldbank")
 * @param {Object} definition - Complete node definition for NodePlatform
 */
export function registerEtlPlugin(type, definition) {
    _etlPluginDefs.set(type, definition);
}

/**
 * Get all registered ETL plugin definitions.
 * @returns {Object[]}
 */
export function getEtlPluginDefinitions() {
    return [..._etlPluginDefs.values()];
}

/**
 * Clear all registered ETL plugin definitions.
 */
export function clearEtlPlugins() {
    _etlPluginDefs.clear();
}

// ── JSON Config Schema → describeConfig / onPanelInput ──────────────

/**
 * Map a JSON config field type to a ConfigDescriptors factory call.
 */
function jsonFieldToDescriptor(key, fieldSchema, currentValue) {
    const id = `etl-plugin-${key}`;
    const label = fieldSchema.label || key;
    const value = currentValue ?? fieldSchema.default ?? '';

    switch (fieldSchema.type) {
        case 'select':
        case 'combobox':
            return ConfigDescriptors.describeSelect({
                id,
                key,
                label,
                value,
                options: fieldSchema.options || [],
                placeholder: fieldSchema.placeholder || '',
            });

        case 'number':
            return ConfigDescriptors.describeNumber({
                id,
                key,
                label,
                value: value === '' ? (fieldSchema.default ?? 0) : value,
                min: fieldSchema.min ?? undefined,
                max: fieldSchema.max ?? undefined,
                step: fieldSchema.step ?? undefined,
            });

        case 'toggle':
        case 'checkbox':
        case 'boolean':
            return ConfigDescriptors.describeToggle({
                id,
                key,
                label,
                value: !!value,
            });

        case 'textarea':
            return ConfigDescriptors.describeTextarea({
                id,
                key,
                label,
                value: value ?? '',
                placeholder: fieldSchema.placeholder || '',
            });

        default: // text, combobox fallback, unknown
            return ConfigDescriptors.describeInput({
                id,
                key,
                label,
                value: value ?? '',
                placeholder: fieldSchema.placeholder || '',
            });
    }
}

/**
 * Build `describeConfig` and `onPanelInput` from a JSON config schema.
 *
 * @param {Object} configSchema - The `config` object from node_def.json
 * @param {string} title - Node title for the panel header
 * @returns {{ describeConfig: Function, onPanelInput: Function }}
 */
function buildConfigFromSchema(configSchema, title) {
    const fieldKeys = Object.keys(configSchema);

    function describeConfig({ nodeId, snapshot = {} }) {
        const config = snapshot.config ?? {};

        const fields = [
            ConfigDescriptors.describeInput({
                id: 'etl-plugin-displayName',
                key: 'displayName',
                label: 'Display Name',
                placeholder: title,
                value: config.displayName ?? '',
            }),
            ...fieldKeys.map(key =>
                jsonFieldToDescriptor(key, configSchema[key], config[key])
            ),
        ];

        return ConfigDescriptors.panel({
            nodeId,
            namespace: snapshot.namespaceId,
            title: config.displayName || title,
            sections: [
                ConfigDescriptors.section({
                    id: 'etl-plugin-config',
                    title: 'Source Configuration',
                    fields,
                }),
            ],
        });
    }

    function onPanelInput({ descriptorKey, value, updateSnapshot }) {
        if (!descriptorKey || typeof updateSnapshot !== 'function') return;
        const patch = { config: { [descriptorKey]: value } };
        updateSnapshot(patch, { reason: 'etl-plugin:panel-input', silent: true });
    }

    return { describeConfig, onPanelInput };
}

/**
 * Load ETL plugin definitions from the backend and register them.
 * Auto-generates `describeConfig` and `onPanelInput` for plugins
 * that have a JSON config schema but no JavaScript definition.
 *
 * @param {{ logger?: object }} options
 */
export async function loadEtlPlugins({ logger } = {}) {
    const api = window.pywebview?.api;
    if (!api?.etl_plugin_list_all) {
        // ETL plugins are an optional subsystem not wired into EcoAgent's
        // bridge; its absence is expected, not a warning to toast at the user.
        logger?.debug?.('ETL plugin API not available');
        return;
    }

    try {
        const result = await api.etl_plugin_list_all();
        if (!result?.ok) {
            logger?.warn?.('ETL plugin load failed', result?.errors);
            return;
        }

        let count = 0;
        for (const plugin of (result.plugins || [])) {
            const def = plugin.definition;
            if (!def?.type) continue;

            // Skip if already registered (e.g., from a JS definition)
            if (_etlPluginDefs.has(def.type)) continue;

            // Auto-generate describeConfig from JSON config schema
            if (!def.describeConfig && def.config && typeof def.config === 'object') {
                const { describeConfig, onPanelInput } = buildConfigFromSchema(
                    def.config,
                    def.title || def.type,
                );
                def.describeConfig = describeConfig;
                def.onPanelInput = onPanelInput;
            }

            registerEtlPlugin(def.type, def);
            count++;
        }

        logger?.info?.(`Registered ${count} ETL plugin definitions`);
    } catch (err) {
        logger?.error?.('Failed to load ETL plugins', { err });
    }
}
