/**
 * results/index.js
 *
 * Main entry point for the results tile dashboard module.
 * Exports all public APIs and auto-initializes when loaded.
 */

// Core components
export { TileBase } from './tile_base.js';
export { TileGrid } from './tile_grid.js';
export { TileRegistry, registerWidget, getWidget, getAllWidgetTypes, createWidget, getWidgetCatalog, getWidgetMetadata } from './tile_registry.js';
export { LayoutPersistence, getLayoutPersistence } from './layout_persistence.js';

// Template system
export { TemplateRegistry } from './templates/template_registry.js';
export { openTemplateGallery, closeTemplateGallery } from './templates/template_gallery.js';

// Configuration schema utilities
export { FieldTypes, validateField, validateConfig, getFieldOptions } from './config/config_schema.js';

// Main dashboard
export { ResultsTileDashboard, getResultsTileDashboard } from './results_tile_dashboard.js';

// Widgets (import to auto-register)
import './widgets/statistics_table.js';
import './widgets/fan_chart.js';
import './widgets/distribution_histogram.js';
import './widgets/correlation_matrix.js';
import './widgets/tornado_diagram.js';
import './widgets/sector_balance_sheet.js';
import './widgets/box_plot_timeline.js';
import './widgets/jacobian_heatmap.js';
import './widgets/convergence_diagnostic.js';
import './widgets/phase_plot.js';
import './widgets/stock_flow_decomposition.js';
import './widgets/transaction_flow_matrix.js';
import './widgets/autocorrelation.js';
import './widgets/spectral_density.js';
import './widgets/plot_tile.js';
import './widgets/kpi_tile.js';
import './widgets/radar_tile.js';
import './widgets/lorenz_tile.js';
import './widgets/sankey_tile.js';
import './widgets/waterfall_tile.js';
import './widgets/decile_bar_tile.js';


// Auto-initialize the dashboard
import { getResultsTileDashboard } from './results_tile_dashboard.js';

// Initialize when DOM is ready
function init() {
    const dashboard = getResultsTileDashboard();

    // Make available globally for integration with existing code
    window.resultsTileDashboard = dashboard;

    window.logger?.nodes('[ResultsModule] Initialized');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
