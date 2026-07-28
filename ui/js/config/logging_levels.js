// Central log level overrides per logging namespace
// Update levels here to control verbosity of specific components without changing code
// Valid levels: trace, debug, info, warn, error, fatal

export const LOGGING_LEVEL_OVERRIDES = {
    'bootstrap': 'info',
    'node-platform': 'warn',
    'plot-node': 'warn',
    'workspace-save': 'info',
    'workspace-import': 'info',
    'data-manager': 'info',
    'data-hub': 'info',
    'expression-services': 'info',
    'connector-router': 'info',
    'canvas-adapter': 'info',
    'connection-renderer': 'info',
    'app-shell': 'info',
    'page-node-workspace': 'info',
    'page-simulation': 'info',
    'page-scenario': 'info',
    'page-data': 'info',
    'stock-viewer-snapshot': 'info',
    'notifications': 'info',
};

export function mergeLoggingLevels(overrides = {}) {
    return { ...LOGGING_LEVEL_OVERRIDES, ...(overrides || {}) };
}