/**
 * Global Application Settings (js_new)
 *
 * Purpose
 * -------
 * Centralized configuration store for application-wide settings.
 * Settings are persisted to localStorage and exposed to the UI via
 * a declarative SCHEMA that drives the Settings page.
 *
 * Usage
 * -----
 * import { getSetting, setSetting } from '../core/settings.js';
 *
 * // Read a setting
 * if (getSetting('workspace.save.showToast')) { ... }
 *
 * // Write a setting (persists to localStorage, emits events)
 * setSetting('window.macShadows', true);
 *
 * // React to changes (after registerSettingsEventBus is called)
 * eventBus.on('settings:window.macShadows:changed', ({ value }) => { ... });
 *
 * Adding New Settings
 * -------------------
 * 1. Add the default value under the appropriate namespace in DEFAULTS.
 * 2. Add a SCHEMA entry with type, category, group, label, description.
 * 3. The Settings page will automatically pick it up.
 */

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = Object.freeze({
    workspace: Object.freeze({
        save: Object.freeze({
            showToast: false,
            showErrorToast: true,
        }),
        import: Object.freeze({
            showToast: false,
            showErrorToast: true,
        }),
        autosave: Object.freeze({
            enabled: true,
            intervalSeconds: 60,
        }),
        undoHistoryLimit: 200,
    }),

    host: Object.freeze({
        showConnectedToast: false,
    }),

    window: Object.freeze({
        animateMinimize: true,
        macShadows: true,
    }),

    notifications: Object.freeze({
        durationMs: 3500,
    }),

    // Only run retention survives from the ported ODE-simulation settings;
    // the solver/tolerance/streaming knobs were scipy-era leftovers with no
    // consumer in EcoAgent's agent engine.
    simulation: Object.freeze({
        runRetention: 3,
    }),

    data: Object.freeze({
        tablePageSize: 100,
        defaultResampleMethod: 'mean',
    }),

    etl: Object.freeze({
        parallelWorkers: 1,
    }),

    logging: Object.freeze({
        minLevel: 'info',
        historyLimit: 500,
        enableConsole: false,
    }),

    editor: Object.freeze({
        autosaveDelayMs: 5000,
    }),

    notebook: Object.freeze({
        cellWidthMode: 'fixed',
        codeCellMaxHeight: false,
        defaultCellView: 'config',
    }),

    debug: Object.freeze({
        logSettingsAccess: false,
    }),

    projects: Object.freeze({
        directory: null,
    }),

    // Only auto-create-defaults survives; the modules directory / addon /
    // ETL-plugin loaders were EcoSim's node-graph plugin system.
    modules: Object.freeze({
        autoCreateDefaults: true,
    }),

    ecoagent: Object.freeze({
        run: Object.freeze({
            defaultTicks: 100,
            coarseRefreshTicks: 10,
            showCompletionToast: false,
            showErrorToast: true,
        }),
        population: Object.freeze({
            sampleSize: 5,
        }),
        eventLog: Object.freeze({
            maxBufferSize: 5000,
        }),
    }),

    ai: Object.freeze({
        provider: '',
        cloud: Object.freeze({
            providerId: 'anthropic',
            providers: Object.freeze({}),
        }),
        local: Object.freeze({
            serverType: 'llamacpp',
            modelPath: '',
            baseUrl: '',
            model: '',
            port: 8080,
            gpuLayers: -1,
            contextLength: 32768,
            flashAttention: true,
            evalBatchSize: 512,
            kvCacheOnGpu: true,
        }),
        defaultMode: 'ask',
        maxToolCalls: 25,
    }),
});

// ─── Schema (drives the Settings page UI) ────────────────────────────────────

/**
 * @typedef {Object} SettingDef
 * @property {'boolean'|'select'|'number'|'text'|'colorList'} type
 * @property {string} category - Category ID (matches CATEGORIES[].id)
 * @property {string} group - Visual group within the category
 * @property {string} label - Human-readable label
 * @property {string} description - Explanation shown below the label
 * @property {*} defaultValue - Must match DEFAULTS
 * @property {Array<{value:string,label:string}>} [options] - For 'select' type
 * @property {number} [min] - For 'number' type
 * @property {number} [max] - For 'number' type
 * @property {number|string} [step] - For 'number' type
 * @property {string} [placeholder] - For 'text' type
 */

const SCHEMA = Object.freeze({
    // ── General ──────────────────────────────────────────────────────────────
    'workspace.save.showToast': {
        type: 'boolean', category: 'general', group: 'Workspace Notifications',
        label: 'Save success notification',
        description: 'Show a toast notification when a workspace is saved successfully.',
        defaultValue: false,
    },
    'workspace.save.showErrorToast': {
        type: 'boolean', category: 'general', group: 'Workspace Notifications',
        label: 'Save error notification',
        description: 'Show a toast notification when a workspace save fails.',
        defaultValue: true,
    },
    'workspace.import.showToast': {
        type: 'boolean', category: 'general', group: 'Workspace Notifications',
        label: 'Import success notification',
        description: 'Show a toast notification when a workspace is imported successfully.',
        defaultValue: false,
    },
    'workspace.import.showErrorToast': {
        type: 'boolean', category: 'general', group: 'Workspace Notifications',
        label: 'Import error notification',
        description: 'Show a toast notification when a workspace import fails.',
        defaultValue: true,
    },
    'host.showConnectedToast': {
        type: 'boolean', category: 'general', group: 'Host Bridge',
        label: 'Host connected notification',
        description: 'Show a toast notification when the desktop host bridge connects.',
        defaultValue: false,
    },
    'notifications.durationMs': {
        type: 'number', category: 'general', group: 'Notifications',
        label: 'Toast notification duration',
        description: 'How long toast notifications stay visible (milliseconds).',
        defaultValue: 3500, min: 1000, max: 15000, step: 500,
    },
    'workspace.autosave.enabled': {
        type: 'boolean', category: 'general', group: 'Auto-Save',
        label: 'Enable auto-save',
        description: 'Automatically save the workspace at regular intervals.',
        defaultValue: true,
    },
    'workspace.autosave.intervalSeconds': {
        type: 'number', category: 'general', group: 'Auto-Save',
        label: 'Auto-save interval (seconds)',
        description: 'Time between automatic saves.',
        defaultValue: 60, min: 10, max: 600, step: 10,
    },
    'workspace.undoHistoryLimit': {
        type: 'number', category: 'general', group: 'History',
        label: 'Undo/redo history depth',
        description: 'Maximum number of undo/redo steps retained in memory.',
        defaultValue: 200, min: 10, max: 1000, step: 10,
    },

    // ── Windows ──────────────────────────────────────────────────────────────
    'window.animateMinimize': {
        type: 'boolean', category: 'window', group: 'Appearance',
        label: 'Animate minimize/restore',
        description: 'Animate managed windows toward/from the taskbar when minimizing and restoring.',
        defaultValue: true,
    },
    'window.macShadows': {
        type: 'boolean', category: 'window', group: 'Appearance',
        label: 'macOS-style shadows',
        description: 'Use multi-layered soft shadows on managed windows.',
        defaultValue: true,
    },

    // ── Data ─────────────────────────────────────────────────────────────────
    'data.tablePageSize': {
        type: 'number', category: 'data', group: 'Tables',
        label: 'Table page size',
        description: 'Number of rows displayed per page in data tables.',
        defaultValue: 100, min: 25, max: 1000, step: 25,
    },
    'data.defaultResampleMethod': {
        type: 'select', category: 'data', group: 'Import',
        label: 'Default resample method',
        description: 'Aggregation method used when resampling imported time series.',
        defaultValue: 'mean',
        options: [
            { value: 'mean', label: 'Mean' },
            { value: 'sum', label: 'Sum' },
            { value: 'last', label: 'Last' },
            { value: 'first', label: 'First' },
            { value: 'linear', label: 'Linear interpolation' },
        ],
    },
    'etl.parallelWorkers': {
        type: 'number', category: 'data', group: 'ETL Pipelines',
        label: 'Parallel pipeline workers',
        description: 'Number of pipelines to execute simultaneously in orchestrations. 1 = sequential.',
        defaultValue: 1, min: 1, max: 8, step: 1,
    },

    // ── Logging ──────────────────────────────────────────────────────────────
    'logging.minLevel': {
        type: 'select', category: 'logging', group: 'Output',
        label: 'Minimum log level',
        description: 'Only messages at this level or above are recorded.',
        defaultValue: 'info',
        options: [
            { value: 'trace', label: 'Trace' },
            { value: 'debug', label: 'Debug' },
            { value: 'info', label: 'Info' },
            { value: 'warn', label: 'Warning' },
            { value: 'error', label: 'Error' },
            { value: 'fatal', label: 'Fatal' },
        ],
    },
    'logging.enableConsole': {
        type: 'boolean', category: 'logging', group: 'Output',
        label: 'Enable console output',
        description: 'Mirror log messages to the browser console.',
        defaultValue: false,
    },
    'logging.historyLimit': {
        type: 'number', category: 'logging', group: 'History',
        label: 'Log history limit',
        description: 'Maximum number of log entries retained in memory.',
        defaultValue: 500, min: 50, max: 10000, step: 50,
    },

    // ── Projects ─────────────────────────────────────────────────────────────
    'projects.directory': {
        type: 'text', category: 'general', group: 'Projects',
        label: 'Projects directory',
        description: 'Default directory for new projects and bundled demos. Leave empty for OS default.',
        defaultValue: null,
        placeholder: 'OS default (%APPDATA%/EcoSim/projects)',
    },

    // ── AI Assistant ────────────────────────────────────────────────────────
    // Provider, auth, model, and server settings are managed from the chat UI
    // modals. Only behavior settings appear here.
    'ai.defaultMode': {
        type: 'select', category: 'ai', group: 'Behavior',
        label: 'Default mode',
        description: 'Default interaction mode for the AI assistant.',
        defaultValue: 'ask',
        options: [
            { value: 'ask', label: 'Ask (preview before applying)' },
            { value: 'edit', label: 'Edit (apply immediately)' },
        ],
    },
    'ai.maxToolCalls': {
        type: 'number', category: 'ai', group: 'Behavior',
        label: 'Max tool calls',
        description: 'Maximum number of tool calls per AI turn.',
        defaultValue: 25, min: 1, max: 100, step: 1,
    },

    // ── Notebook ─────────────────────────────────────────────────────────────
    'notebook.cellWidthMode': {
        type: 'select', category: 'notebook', group: 'Layout',
        label: 'Cell width mode',
        description: 'Controls how wide all cells appear. "Fixed" constrains cells to a max-width; "Full" stretches all cells.',
        defaultValue: 'fixed',
        options: [
            { value: 'fixed',   label: 'Fixed width (900px)' },
            { value: 'full',    label: 'Full width' },
        ],
    },
    'notebook.codeCellMaxHeight': {
        type: 'boolean', category: 'notebook', group: 'Layout',
        label: 'Limit code cell height',
        description: 'When enabled, code cells have a maximum height and scroll internally instead of expanding to show all content.',
        defaultValue: false,
    },
    'notebook.paramCellMaxHeight': {
        type: 'boolean', category: 'notebook', group: 'Layout',
        label: 'Limit parameter cell height',
        description: 'When enabled, parameter cells have a maximum height and scroll internally instead of expanding to show all content.',
        defaultValue: false,
    },
    'notebook.defaultCellView': {
        type: 'select', category: 'notebook', group: 'Layout',
        label: 'Default cell view',
        description: 'Which tab to show by default on all cells: Config (edit) or EcoLang (generated code).',
        defaultValue: 'config',
        options: [
            { value: 'config',  label: 'Config' },
            { value: 'dsl',     label: 'EcoLang' },
        ],
    },

    // ── Advanced ─────────────────────────────────────────────────────────────
    'editor.autosaveDelayMs': {
        type: 'number', category: 'advanced', group: 'Performance',
        label: 'Editor autosave delay (ms)',
        description: 'Delay before the function editor auto-saves changes.',
        defaultValue: 5000, min: 1000, max: 30000, step: 1000,
    },
    'debug.logSettingsAccess': {
        type: 'boolean', category: 'advanced', group: 'Debug',
        label: 'Log settings access',
        description: 'Log all getSetting/setSetting calls to the console for debugging.',
        defaultValue: false,
    },
    'modules.autoCreateDefaults': {
        type: 'boolean', category: 'advanced', group: 'Modules',
        label: 'Auto-create default modules',
        description: 'Create the default Economy module if it does not exist in the modules directory.',
        defaultValue: true,
    },

    // ── EcoAgent ─────────────────────────────────────────────────────────────
    'ecoagent.run.defaultTicks': {
        type: 'number', category: 'ecoagent', group: 'Run',
        label: 'Default ticks per run',
        description: 'Seed value for the Run button\'s tick input on first use. Once changed in the topbar, the last-used value is remembered separately.',
        defaultValue: 100, min: 1, max: 1000000, step: 1,
    },
    'ecoagent.run.coarseRefreshTicks': {
        type: 'number', category: 'ecoagent', group: 'Run',
        label: 'UI refresh interval (ticks)',
        description: 'How many world ticks between full UI refreshes (Population table, Bus snapshot, Event log fetch) while a run is in flight. Lower = more responsive, higher = lower overhead on long runs.',
        defaultValue: 10, min: 1, max: 1000, step: 1,
    },
    'ecoagent.run.showCompletionToast': {
        type: 'boolean', category: 'ecoagent', group: 'Run Notifications',
        label: 'Run completion toast',
        description: 'Show a toast when a world run finishes successfully.',
        defaultValue: false,
    },
    'ecoagent.run.showErrorToast': {
        type: 'boolean', category: 'ecoagent', group: 'Run Notifications',
        label: 'Run error toast',
        description: 'Show a toast when a world run halts with an error.',
        defaultValue: true,
    },
    'simulation.runRetention': {
        type: 'number', category: 'ecoagent', group: 'Run History',
        label: 'Runs to keep per scenario',
        description: 'Number of previous runs to retain per scenario. 0 = unlimited.',
        defaultValue: 3, min: 0, max: 100, step: 1,
    },
    'ecoagent.population.sampleSize': {
        type: 'number', category: 'ecoagent', group: 'Population',
        label: 'Population sample size',
        description: 'How many archetype instances to show in the Population tab. Larger values show more agents per archetype but cost more to render on every tick.',
        defaultValue: 5, min: 1, max: 200, step: 1,
    },
    'ecoagent.eventLog.maxBufferSize': {
        type: 'number', category: 'ecoagent', group: 'Bus & Event Log',
        label: 'Event log buffer cap',
        description: 'Max number of events kept in the in-memory buffer that feeds the Bus snapshot and Bus Inspector windows. When the cap is exceeded, the oldest events are dropped. Set to 0 to keep everything (uses more memory on long runs).',
        defaultValue: 5000, min: 0, max: 1000000, step: 100,
    },
});

const CATEGORIES = Object.freeze([
    { id: 'general',    label: 'General',      icon: 'tune',         description: 'Workspace behavior and notifications' },
    { id: 'ecoagent',   label: 'EcoAgent',     icon: 'hub',          description: 'Agent runs, population, and bus inspector' },
    { id: 'ai',         label: 'AI Assistant', icon: 'smart_toy',    description: 'AI assistant behavior' },
    { id: 'window',     label: 'Windows',      icon: 'web_asset',    description: 'Managed window animation and appearance' },
    { id: 'data',       label: 'Data',         icon: 'database',     description: 'Table display, import, and pipeline defaults' },
    { id: 'logging',    label: 'Logging',      icon: 'terminal',     description: 'Log level, console output, and history' },
    { id: 'notebook',   label: 'Notebook',     icon: 'menu_book',    description: 'Notebook editor layout and behavior' },
    { id: 'advanced',   label: 'Advanced',     icon: 'code',         description: 'Debug and developer settings' },
]);

// ─── Persistence ─────────────────────────────────────────────────────────────

const STORAGE_KEY = 'ecosim.settings.v1';

/**
 * Traverse an object by dot-path parts and return the value.
 * @param {object} obj
 * @param {string[]} parts
 * @returns {*}
 */
function _getNestedValue(obj, parts) {
    let current = obj;
    for (const part of parts) {
        if (current === null || current === undefined || typeof current !== 'object') {
            return undefined;
        }
        current = current[part];
    }
    return current;
}

/**
 * Set a value in a nested object by dot-path parts, creating intermediates.
 * @param {object} obj
 * @param {string[]} parts
 * @param {*} value
 */
function _setNestedValue(obj, parts, value) {
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] === undefined || current[parts[i]] === null || typeof current[parts[i]] !== 'object') {
            current[parts[i]] = {};
        }
        current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
}

/**
 * Deep equality check for primitives, arrays, and plain objects.
 */
function _deepEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        return a.every((v, i) => _deepEqual(v, b[i]));
    }
    if (typeof a === 'object') {
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        return keysA.every(k => _deepEqual(a[k], b[k]));
    }
    return false;
}

/**
 * Load user-persisted settings from localStorage (sparse merge).
 * Only known SCHEMA paths are restored; unknown keys are ignored.
 */
function _loadPersistedSettings() {
    try {
        if (typeof localStorage === 'undefined') return;
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        for (const path of Object.keys(SCHEMA)) {
            const parts = path.split('.');
            const value = _getNestedValue(saved, parts);
            if (value !== undefined) {
                _setNestedValue(_settings, parts, value);
            }
        }
    } catch (err) {
        console.warn('[Settings] Failed to load persisted settings', err);
    }
}

/**
 * Persist settings that differ from defaults (sparse storage).
 */
function _persistSettings() {
    try {
        if (typeof localStorage === 'undefined') return;
        const sparse = {};
        for (const path of Object.keys(SCHEMA)) {
            const parts = path.split('.');
            const current = _getNestedValue(_settings, parts);
            const def = SCHEMA[path].defaultValue;
            if (!_deepEqual(current, def)) {
                _setNestedValue(sparse, parts, current);
            }
        }
        if (Object.keys(sparse).length === 0) {
            localStorage.removeItem(STORAGE_KEY);
        } else {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(sparse));
        }
    } catch (err) {
        console.warn('[Settings] Failed to persist settings', err);
    }
}

// ─── EventBus integration ────────────────────────────────────────────────────

let _eventBus = null;

/**
 * Register the EventBus instance for settings change notifications.
 * Called once during app bootstrap.
 * @param {object} eventBus
 */
export function registerSettingsEventBus(eventBus) {
    _eventBus = eventBus;
}

function _emitSettingChanged(path, value) {
    if (!_eventBus) return;
    _eventBus.emit(`settings:${path}:changed`, { path, value });
    _eventBus.emit('settings:changed', { path, value });
}

// ─── Runtime store ───────────────────────────────────────────────────────────

const _settings = JSON.parse(JSON.stringify(DEFAULTS));

// Load persisted overrides before any consumer can call getSetting
_loadPersistedSettings();

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Get a setting value by dot-notation path.
 * @param {string} path - Dot-separated path (e.g., 'workspace.save.showToast')
 * @param {*} [defaultValue] - Fallback if path not found
 * @returns {*} The setting value or defaultValue
 */
export function getSetting(path, defaultValue = undefined) {
    const parts = path.split('.');
    let current = _settings;

    for (const part of parts) {
        if (current === null || current === undefined || typeof current !== 'object') {
            if (_settings.debug?.logSettingsAccess) {
                console.warn(`[Settings] Path not found: ${path}`);
            }
            return defaultValue;
        }
        current = current[part];
    }

    if (current === undefined) {
        return defaultValue;
    }

    if (_settings.debug?.logSettingsAccess) {
        console.log(`[Settings] getSetting('${path}') =>`, current);
    }

    return current;
}

/**
 * Set a setting value. Persists to localStorage and emits change events.
 * @param {string} path - Dot-separated path
 * @param {*} value - Value to set
 * @returns {boolean} True if set successfully
 */
export function setSetting(path, value) {
    const parts = path.split('.');
    const lastPart = parts.pop();
    let current = _settings;

    for (const part of parts) {
        if (current[part] === undefined || current[part] === null) {
            current[part] = {};
        }
        if (typeof current[part] !== 'object') {
            console.warn(`[Settings] Cannot set '${path}': intermediate path is not an object`);
            return false;
        }
        current = current[part];
    }

    current[lastPart] = value;

    if (_settings.debug?.logSettingsAccess) {
        console.log(`[Settings] setSetting('${path}', ${JSON.stringify(value)})`);
    }

    _persistSettings();
    _emitSettingChanged(path, value);
    return true;
}

/**
 * Get the default value for a setting path.
 * @param {string} path - Dot-separated path
 * @returns {*} The default value, or undefined if path not in SCHEMA
 */
export function getDefaultValue(path) {
    const def = SCHEMA[path];
    if (!def) {
        // Fallback: traverse DEFAULTS directly
        const parts = path.split('.');
        return _getNestedValue(DEFAULTS, parts);
    }
    // Return a deep copy for objects/arrays
    const val = def.defaultValue;
    return (val !== null && typeof val === 'object') ? JSON.parse(JSON.stringify(val)) : val;
}

/**
 * Reset a setting to its default value.
 * @param {string} path - Dot-separated path
 * @returns {boolean} True if reset successfully
 */
export function resetSetting(path) {
    const defaultVal = getDefaultValue(path);
    if (defaultVal === undefined) {
        console.warn(`[Settings] No default found for '${path}'`);
        return false;
    }
    return setSetting(path, defaultVal);
}

/**
 * Reset all settings in a category to their defaults.
 * @param {string} categoryId
 */
export function resetCategory(categoryId) {
    for (const [path, def] of Object.entries(SCHEMA)) {
        if (def.category === categoryId) {
            const defaultVal = (def.defaultValue !== null && typeof def.defaultValue === 'object')
                ? JSON.parse(JSON.stringify(def.defaultValue))
                : def.defaultValue;
            const parts = path.split('.');
            _setNestedValue(_settings, parts, defaultVal);
        }
    }
    _persistSettings();
    if (_eventBus) {
        _eventBus.emit('settings:category:reset', { category: categoryId });
        _eventBus.emit('settings:changed', { path: null, category: categoryId });
    }
}

/**
 * Reset all settings to their defaults.
 */
export function resetAllSettings() {
    for (const [path, def] of Object.entries(SCHEMA)) {
        const defaultVal = (def.defaultValue !== null && typeof def.defaultValue === 'object')
            ? JSON.parse(JSON.stringify(def.defaultValue))
            : def.defaultValue;
        const parts = path.split('.');
        _setNestedValue(_settings, parts, defaultVal);
    }
    _persistSettings();
    if (_eventBus) {
        _eventBus.emit('settings:reset', {});
        _eventBus.emit('settings:changed', { path: null });
    }
}

/**
 * Get all settings as a plain object (for serialization or debugging).
 * @returns {object} Deep copy of current settings
 */
export function getAllSettings() {
    return JSON.parse(JSON.stringify(_settings));
}

// ─── Schema / Category API (for Settings page UI) ───────────────────────────

/**
 * Get the full settings schema.
 * @returns {Object<string, SettingDef>}
 */
export function getSchema() {
    return SCHEMA;
}

/**
 * Get the categories list.
 * @returns {Array<{id:string, label:string, icon:string, description:string}>}
 */
export function getCategories() {
    return CATEGORIES;
}

/**
 * Get all settings definitions for a given category, in schema order.
 * @param {string} categoryId
 * @returns {Array<{path:string} & SettingDef>}
 */
export function getSettingsByCategory(categoryId) {
    const result = [];
    for (const [path, def] of Object.entries(SCHEMA)) {
        if (def.category === categoryId) {
            result.push({ path, ...def });
        }
    }
    return result;
}

/**
 * Direct access to settings namespaces.
 * Prefer getSetting() for safety, but this provides convenient direct access.
 */
export const Settings = _settings;

// Freeze the public Settings object to prevent accidental mutation
// (setSetting should be used for intentional changes)
Object.freeze(Settings);
