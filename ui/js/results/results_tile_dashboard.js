/**
 * results_tile_dashboard.js
 *
 * Main integration file for the tile-based results dashboard.
 * Brings together TileGrid, widgets, layout persistence, and configuration.
 */

import { TileGrid } from './tile_grid.js';
import { TileRegistry, getWidgetCatalog } from './tile_registry.js';
import { getLayoutPersistence } from './layout_persistence.js';

import { ComparisonDataCache } from './comparison_data_cache.js';
import { PanelController } from '../ui/controllers/panel_controller.js';
import { ConfigDescriptors } from '../nodes/config_descriptors.js';
import { attachInlineRenamer } from '../ui/components/inline_renamer.js';
import { showConfirmDialog, showDeleteConfirmDialog } from '../ui/components/confirm_dialog.js';
import { TemplateRegistry } from './templates/template_registry.js';
import { openTemplateGallery } from './templates/template_gallery.js';
import { getDemoData } from './templates/template_demo_data.js';
import { ActionDropdown } from '../ui/components/action_dropdown.js';
import { formatVariableLabel } from './config/config_schema.js';
import { SlideOutPanel } from '../ui/components/slide_out_panel.js';

// Import widgets to register them
import './widgets/statistics_table.js';
import './widgets/fan_chart.js';
import './widgets/distribution_histogram.js';
import './widgets/correlation_matrix.js';
import './widgets/tornado_diagram.js';

export class ResultsTileDashboard {
    /**
     * @param {Object} options
     * @param {Object} [options.eventBus] - Event bus instance
     */
    constructor(options = {}) {
        this.eventBus = options.eventBus || window.eventManager;
        this.tileGrid = null;
        this.container = null;
        this.currentScenarioId = null;
        this.currentScenario = null;
        this.currentData = null;
        this.layoutPersistence = getLayoutPersistence();
        this.panelController = null;
        this._slideOutPanel = null;
        this._currentConfigTileId = null;
        this._initialized = false;
        this._availableRuns = [];
        this._selectedRunId = null;
        this._selectedNamespace = 'All';
        this._namespaces = [];
        this._selectedVariable = 'All';
        this._variables = [];

        // Sample data state — true when dashboard shows placeholder data
        this._showingSampleData = false;

        // Template that was actually loaded on the grid (from resolve(), not resolveAll())
        this._loadedTemplateId = null;

        // Scenario comparison state
        this._comparisonCache = null;
        this._comparisonScenarioIds = [];
        this._comparisonEnabled = false;
        /** @type {Array<{id: string, name: string}>} Available scenarios for comparison */
        this._availableScenarios = [];
    }

    /**
     * Initialize the dashboard.
     */
    init() {
        if (this._initialized) return;

        // Set up event listeners (may be null if eventBus not available yet)
        this._attachEventListeners();

        this._initialized = true;
        window.logger?.nodes('[ResultsTileDashboard] Initialized');
    }

    /**
     * Attach event listeners.
     * Called during init and also during render to ensure we have the eventBus.
     * @private
     */
    _attachEventListeners() {
        // If we already have listeners attached, skip
        if (this._eventListenersAttached) return;

        // Try to get eventBus if not already set
        if (!this.eventBus) {
            this.eventBus = window.eventManager;
        }

        // Listen for simulation completion and widget config events
        if (this.eventBus) {
            this._eventListenersAttached = true;
            this.eventBus.on('dataset:updated', (payload) => {
                // payload is passed directly by EventBus (not wrapped in event.detail)
                if (payload?.complete && payload?.source === 'simulation-complete') {
                    this._onSimulationComplete(payload);
                }
            });

            // Listen for close request from application shell (toggle button clicked)
            this.eventBus.on('widget-config:close-requested', () => {
                if (this._currentConfigTileId) {
                    this._closeConfigPanel();
                }
            });

            window.logger?.nodes('[ResultsTileDashboard] Event listeners attached');
        }
    }

    /**
     * Handle simulation completion.
     * @param {Object} payload - Event payload with result data
     * @private
     */
    async _onSimulationComplete(payload) {
        window.logger?.simulation('[ResultsTileDashboard] Simulation complete, scenarioId:', payload?.scenarioId);

        // Check if this is for the currently displayed scenario
        if (payload?.scenarioId && payload.scenarioId !== this.currentScenarioId) {
            window.logger?.simulation('[ResultsTileDashboard] Ignoring - different scenario');
            return;
        }

        // Use result directly from payload if available (faster)
        if (payload?.result?.analytics) {
            this.currentData = payload.result.analytics;
            window.logger?.simulation('[ResultsTileDashboard] Using analytics from event payload');
        } else {
            // Fallback to loading data
            await this._loadData();
        }

        // Refresh if currently visible
        if (this.tileGrid && this.currentData) {
            // When switching from sample to real data, clear sample variable
            // references from tile configs so widgets auto-select from real data
            if (this._showingSampleData) {
                this._removeSampleDataBadge();
                this._clearSampleVariableRefs();
            }

            // Update namespaces from new data
            this._namespaces = this._extractNamespaces(this.currentData);
            this._updateNamespaceDropdown();

            // Reset variable filter and update variable dropdown
            this._selectedVariable = 'All';
            this._updateVariableDropdown();

            // Apply namespace and variable filter and update grid
            const filteredData = this._filterData(this.currentData, this._selectedNamespace, this._selectedVariable);
            this.tileGrid.fullData = this.currentData;
            this.tileGrid.setData(filteredData);
            window.logger?.simulation('[ResultsTileDashboard] Grid data updated');

            // Refresh comparison data if comparison is active
            if (this._comparisonEnabled && this._comparisonScenarioIds.length > 0) {
                this._pushComparisonData();
            }
        }
    }

    /**
     * Render the tile dashboard into a container.
     * @param {string} scenarioId - Scenario identifier
     * @param {HTMLElement} container - Container element
     */
    async render(scenarioId, container) {
        this.currentScenarioId = scenarioId;
        this.container = container;

        // Ensure event listeners are attached (in case eventBus wasn't available during init)
        this._attachEventListeners();

        // Clear container
        container.innerHTML = '';
        // Add results-specific class without overwriting existing classes
        container.classList.add('results-tile-dashboard');

        // Show loading state
        container.innerHTML = `
            <div class="tile-loading-state">
                <span class="material-symbols-outlined spinning">progress_activity</span>
                <span>Loading results...</span>
            </div>
        `;

        // Load available runs for this scenario
        await this._loadAvailableRuns();

        // Load analytics data (for latest run by default)
        await this._loadData();

        // Clear loading state
        container.innerHTML = '';

        const hasData = this.currentData && Object.keys(this.currentData).length > 0;

        // When no real data, substitute sample data so the dashboard renders fully
        if (!hasData) {
            this.currentData = this._generateSampleData();
            this._showingSampleData = true;
        } else {
            this._showingSampleData = false;
        }

        // Extract namespaces/variables from data (real or sample)
        this._namespaces = this._extractNamespaces(this.currentData);
        this._selectedNamespace = this._restoreNamespaceSelection();
        this._selectedVariable = 'All';
        this._variables = this._extractVariables(this.currentData, this._selectedNamespace);

        // Initialize comparison cache and load available scenarios
        this._initComparisonCache();
        await this._loadAvailableScenarios();

        // Create dashboard wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'results-dashboard-wrapper';
        wrapper.style.position = 'relative';
        wrapper.style.overflow = 'hidden';
        container.appendChild(wrapper);

        // Render the combined toolbar header (run selector + action buttons)
        this._renderToolbarHeader(wrapper);

        // Create tile grid container
        const gridContainer = document.createElement('div');
        gridContainer.className = 'results-grid-container';
        wrapper.appendChild(gridContainer);

        // Slide-out config panel + PanelController
        this._initConfigPanel(wrapper);

        // Listen for panel input changes
        this._wirePanelEvents();

        // Create tile grid (toolbar disabled - we use our own header bar)
        this.tileGrid = new TileGrid({
            container: gridContainer,
            eventBus: this.eventBus,
            showToolbar: false,
            onLayoutChange: (layout) => this._onLayoutChange(layout)
        });

        // Check if stored configs are stale (template set changed)
        // If stale, skip loading from active config so we fall through to fresh template resolution
        const templateSetStale = this._isTemplateSetStale();

        // Load saved layout from active configuration first, fallback to template-aware layout
        let savedLayout = null;
        const activeConfig = !templateSetStale
            ? this.layoutPersistence.getActiveConfiguration(scenarioId)
            : null;
        if (activeConfig?.tiles && activeConfig.tiles.length > 0) {
            savedLayout = { tiles: activeConfig.tiles, version: activeConfig.version, templateId: activeConfig.templateId };
            window.logger?.nodes('[ResultsTileDashboard] Loaded layout from active configuration:', activeConfig.name);
        } else {
            savedLayout = this.layoutPersistence.getLayout(scenarioId, this.currentScenario);
            const templateId = savedLayout?.templateId;
            if (templateId) {
                window.logger?.nodes(`[ResultsTileDashboard] Auto-applied template: ${templateId}`);
            } else {
                window.logger?.nodes('[ResultsTileDashboard] Loaded layout from simple storage');
            }
        }
        // For static runs, filter out MC-only tiles from the layout
        if (this.currentData?.meta?.type !== 'monte-carlo' && savedLayout?.tiles) {
            savedLayout = {
                ...savedLayout,
                tiles: savedLayout.tiles.filter(tile => {
                    const WidgetClass = TileRegistry.get(tile.type);
                    return !WidgetClass?.REQUIRES_MC;
                }),
            };
        }

        // When showing sample data, upgrade to the template's demo profile so variable names match
        this._upgradeSampleDataForTemplate(savedLayout?.templateId, savedLayout?.tiles);

        // When showing sample data, clear tile variable refs that the demo data doesn't cover
        if (this._showingSampleData && savedLayout?.tiles) {
            this._clearStaleVariableRefs(savedLayout.tiles, this.currentData);
        }

        // Strip sample variable references from saved layout when real data is available
        if (!this._showingSampleData && savedLayout?.tiles) {
            this._stripSampleRefsFromLayout(savedLayout.tiles);
        }

        // Track the template that was actually loaded on the grid
        this._loadedTemplateId = savedLayout?.templateId || null;

        this.tileGrid.setLayout(savedLayout);

        // Set data (real or sample) filtered by namespace and variable selection
        const filteredData = this._filterData(this.currentData, this._selectedNamespace, this._selectedVariable);
        this.tileGrid.fullData = this.currentData;
        this.tileGrid.setData(filteredData);

        // Ensure we have at least a "Default" dashboard config (after tileGrid has layout)
        this._ensureTemplateDashboards();

        // Refresh toolbar to show the correct dashboard name now that we have config
        this._refreshToolbar();

        // Show sample-data badge if using placeholder data
        if (this._showingSampleData) {
            this._showSampleDataBadge();
        }

        // Listen for tile config requests (on wrapper since tiles are nested inside)
        this._attachTileEventListeners(wrapper);

        // Push comparison data if comparison was restored from localStorage
        if (!this._showingSampleData && this._comparisonEnabled && this._comparisonScenarioIds.length > 0) {
            this._pushComparisonData();
        }
    }

    /**
     * Load available runs for the current scenario.
     * @private
     */
    async _loadAvailableRuns() {
        this._availableRuns = [];
        this._selectedRunId = null;

        try {
            // Get scenario info with runs from the scenario page or controller
            const ecosimNew = window.__ECOSIM_JS_NEW__;
            const hostBridge = ecosimNew?.hostBridge || window.pywebview?.api;

            if (hostBridge?.sim_list_scenarios) {
                const response = await hostBridge.sim_list_scenarios();
                if (response?.ok && response.scenarios) {
                    const scenario = response.scenarios.find(s => s.id === this.currentScenarioId);
                    if (scenario) {
                        // Store scenario metadata for template resolution
                        this.currentScenario = scenario;
                        if (scenario.runs && Array.isArray(scenario.runs)) {
                            this._availableRuns = scenario.runs.map(run => ({
                                id: run.id,
                                createdAt: run.createdAt,
                                summary: run.summary,
                                label: this._formatRunLabel(run)
                            }));
                            // Select the most recent run by default
                            if (this._availableRuns.length > 0) {
                                this._selectedRunId = this._availableRuns[0].id;
                            }
                        }
                    }
                }
            }
        } catch (err) {
            window.logger?.warn('nodes', '[ResultsTileDashboard] Failed to load available runs:', err);
        }
    }

    /**
     * Format a run label for display.
     * @param {Object} run - Run object
     * @returns {string} Formatted label
     * @private
     */
    _formatRunLabel(run) {
        const date = run.createdAt ? new Date(run.createdAt) : null;
        const dateStr = date ? date.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }) : 'Unknown';

        const meta = run.summary?.meta || {};
        const type = meta.type || 'static';
        const runs = meta.num_runs;

        if (type === 'monte-carlo' && runs) {
            return `${dateStr} (MC: ${runs} runs)`;
        }
        return dateStr;
    }

    /**
     * Render the combined toolbar header with dashboard info and action buttons.
     * Layout:
     *   Left: Dashboard name | Edit | Delete | Switch | New | Namespace filter | Variable filter
     *   Right: Add Widget | Reset | Export
     * @param {HTMLElement} container
     * @private
     */
    _renderToolbarHeader(container) {
        const header = document.createElement('div');
        header.className = 'results-toolbar-header';

        // NOTE: _ensureTemplateDashboards is now called after tileGrid is created in render()

        // Get current dashboard info
        const configs = this.layoutPersistence.listConfigurations(this.currentScenarioId);
        const activeConfig = this.layoutPersistence.getActiveConfiguration(this.currentScenarioId);
        const dashboardName = activeConfig?.name || 'Default';
        const canDelete = configs.length > 1;

        // Build namespace selector HTML
        const namespaceSelectorHtml = this._namespaces.length > 0 ? `
            <div class="toolbar-group namespace-selector-group">
                <span class="material-symbols-outlined toolbar-icon">folder</span>
                <select class="namespace-selector-dropdown has-tooltip" data-tooltip="Filter by namespace">
                    <option value="All" ${this._selectedNamespace === 'All' ? 'selected' : ''}>All</option>
                    ${this._namespaces.map(ns => `
                        <option value="${ns}" ${ns === this._selectedNamespace ? 'selected' : ''}>
                            ${this._escapeHtml(ns)}
                        </option>
                    `).join('')}
                </select>
            </div>
        ` : '';

        // Build variable selector HTML
        const variableSelectorHtml = this._variables.length > 0 ? `
            <div class="toolbar-group variable-selector-group">
                <span class="material-symbols-outlined toolbar-icon">data_object</span>
                <select class="variable-selector-dropdown has-tooltip" data-tooltip="Filter by variable">
                    <option value="All" ${this._selectedVariable === 'All' ? 'selected' : ''}>All</option>
                    ${this._variables.map(v => `
                        <option value="${v}" ${v === this._selectedVariable ? 'selected' : ''}>
                            ${this._escapeHtml(formatVariableLabel(v))}
                        </option>
                    `).join('')}
                </select>
            </div>
        ` : '';

        header.innerHTML = `
            <div class="toolbar-left">
                <div class="dashboard-info">
                    <span class="dashboard-name has-tooltip" data-tooltip="Double-click to rename">${this._escapeHtml(dashboardName)}</span>
                    <button class="toolbar-btn-icon btn-rename-dashboard has-tooltip" data-tooltip="Rename dashboard">
                        <span class="material-symbols-outlined">edit</span>
                    </button>
                    <button class="toolbar-btn-icon btn-delete-dashboard has-tooltip" data-tooltip="Delete dashboard" ${!canDelete ? 'disabled' : ''}>
                        <span class="material-symbols-outlined">delete</span>
                    </button>
                    <div class="dashboard-selector-container">
                        <button class="toolbar-btn-icon btn-dashboard-selector has-tooltip" data-tooltip="Switch dashboard">
                            <span class="material-symbols-outlined">expand_more</span>
                        </button>
                        <div class="dashboard-selector-dropdown" hidden></div>
                    </div>
                </div>
                ${namespaceSelectorHtml}
                ${variableSelectorHtml}
            </div>
            <div class="toolbar-right">
                <div class="compare-container">
                    <button class="toolbar-btn-icon btn-compare has-tooltip ${this._comparisonEnabled ? 'is-active' : ''}" data-tooltip="Compare scenarios">
                        <span class="material-symbols-outlined">compare_arrows</span>
                    </button>
                    <div class="compare-dropdown" hidden></div>
                </div>
                <button class="toolbar-btn-icon btn-templates has-tooltip" data-tooltip="Dashboard templates">
                    <span class="material-symbols-outlined">auto_awesome_mosaic</span>
                </button>
                <button class="toolbar-btn-icon btn-add-widget has-tooltip" data-tooltip="Add widget">
                    <span class="material-symbols-outlined">add</span>
                </button>
                <button class="toolbar-btn-icon btn-reset-layout has-tooltip" data-tooltip="Reset layout">
                    <span class="material-symbols-outlined">restart_alt</span>
                </button>
            </div>
        `;

        // Wire up namespace selector
        const namespaceDropdown = header.querySelector('.namespace-selector-dropdown');
        namespaceDropdown?.addEventListener('change', (e) => {
            this._onNamespaceSelected(e.target.value);
        });

        // Wire up variable selector
        const variableDropdown = header.querySelector('.variable-selector-dropdown');
        variableDropdown?.addEventListener('change', (e) => {
            this._onVariableSelected(e.target.value);
        });

        // Wire up dashboard name double-click to rename
        const dashboardNameEl = header.querySelector('.dashboard-name');
        dashboardNameEl?.addEventListener('dblclick', () => this._renameActiveDashboard());

        // Wire up rename button
        header.querySelector('.btn-rename-dashboard')?.addEventListener('click', () => this._renameActiveDashboard());

        // Wire up delete button
        const deleteBtn = header.querySelector('.btn-delete-dashboard');
        deleteBtn?.addEventListener('click', () => this._deleteActiveDashboard());

        // Wire up dashboard selector dropdown (custom content — use ActionDropdown.position())
        const selectorBtn = header.querySelector('.btn-dashboard-selector');
        const selectorDropdown = header.querySelector('.dashboard-selector-dropdown');
        if (selectorBtn && selectorDropdown) {
            selectorBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleDashboardSelector(selectorDropdown, selectorBtn);
            });
            this._populateDashboardSelector(selectorDropdown);
        }

        // Wire up compare dropdown (custom content — use ActionDropdown.position())
        const compareBtn = header.querySelector('.btn-compare');
        const compareDropdown = header.querySelector('.compare-dropdown');
        compareBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleCompareDropdown(compareDropdown, compareBtn);
        });

        // Wire up templates button
        header.querySelector('.btn-templates')?.addEventListener('click', () => this._openTemplateGallery());

        // Wire up add widget via ActionDropdown
        const addWidgetBtn = header.querySelector('.btn-add-widget');
        const runType = this.currentData?.meta?.type || 'static';
        const catalog = getWidgetCatalog({ runType });
        this._addWidgetDropdown?.destroy();
        this._addWidgetDropdown = new ActionDropdown({
            trigger: addWidgetBtn,
            options: catalog.map(w => ({ type: w.type, label: w.title, icon: w.icon, description: w.description })),
            onSelect: (opt) => this._addWidget(opt.type),
            className: 'add-widget-dropdown-menu'
        });

        // Wire up reset
        header.querySelector('.btn-reset-layout')?.addEventListener('click', () => this._resetLayout());

        // Close custom dropdowns when clicking outside
        this._toolbarOutsideClick = (e) => {
            if (selectorDropdown && !selectorDropdown.contains(e.target) && !selectorBtn?.contains(e.target)) {
                this._closeDashboardSelector(selectorDropdown, selectorBtn);
            }
            if (compareDropdown && !compareDropdown.contains(e.target) && !compareBtn?.contains(e.target)) {
                this._closeCompareDropdown(compareDropdown, compareBtn);
            }
        };
        document.addEventListener('click', this._toolbarOutsideClick);

        container.appendChild(header);
        this._toolbarHeader = header;
    }

    /**
     * Create named dashboards from all matching templates for the current scenario.
     * Each template becomes a separate named configuration. The highest-priority
     * template's dashboard becomes active. Detects stale configs via template set
     * fingerprint and regenerates when templates have changed.
     * Must be called AFTER tileGrid is created and has a layout.
     * @private
     */
    /**
     * Check if the stored template set fingerprint is stale (templates have changed).
     * @returns {boolean} True if stored configs are stale or missing
     * @private
     */
    _isTemplateSetStale() {
        if (!this.currentScenarioId) return false;

        const templates = TemplateRegistry.resolveAll(this.currentScenario);
        const templateSetId = templates.map(t => t.id).join(',');
        const storedSetId = this.layoutPersistence.getTemplateSetId(this.currentScenarioId);

        return storedSetId !== templateSetId;
    }

    _ensureTemplateDashboards() {
        if (!this.currentScenarioId) return;

        const templates = TemplateRegistry.resolveAll(this.currentScenario);

        // The grid was loaded via resolve() which may pick a different (better)
        // template than resolveAll().  Ensure the actually-loaded template is
        // included as the first entry so the persisted config matches the grid.
        const loadedTemplate = this._loadedTemplateId
            ? TemplateRegistry.get(this._loadedTemplateId)
            : null;
        if (loadedTemplate && !templates.some(t => t.id === loadedTemplate.id)) {
            templates.unshift(loadedTemplate);
        }

        const templateSetId = templates.map(t => t.id).join(',');

        // Check if existing configs match the current template set
        const storedSetId = this.layoutPersistence.getTemplateSetId(this.currentScenarioId);
        if (storedSetId === templateSetId) return;

        // Clear stale configs (templates changed or first load)
        this.layoutPersistence.clearConfigurations(this.currentScenarioId);

        const isMC = this.currentData?.meta?.type === 'monte-carlo';
        let firstConfigId = null;

        for (let i = 0; i < templates.length; i++) {
            let tiles;

            if (i === 0) {
                // First template matches what's already rendered on the tileGrid
                tiles = this.tileGrid?.getLayout() || [];
            } else {
                const instantiated = TemplateRegistry.instantiate(templates[i]);
                tiles = instantiated.tiles;

                // Filter MC-only tiles for static runs
                if (!isMC) {
                    tiles = tiles.filter(tile => {
                        const WidgetClass = TileRegistry.get(tile.type);
                        return !WidgetClass?.REQUIRES_MC;
                    });
                }
            }

            const configId = this.layoutPersistence.saveConfiguration(
                this.currentScenarioId,
                templates[i].name,
                tiles,
                { templateId: templates[i].id }
            );

            if (i === 0) firstConfigId = configId;
        }

        if (firstConfigId) {
            this.layoutPersistence.setActiveConfiguration(this.currentScenarioId, firstConfigId);
        }

        // Store fingerprint so we don't regenerate on next load
        this.layoutPersistence.setTemplateSetId(this.currentScenarioId, templateSetId);

        window.logger?.nodes(
            `[ResultsTileDashboard] Created ${templates.length} dashboard(s) from templates`
        );
    }

    /**
     * Schedule auto-save of the current layout (debounced).
     * @private
     */
    _scheduleAutoSave() {
        if (this._autoSaveTimer) {
            clearTimeout(this._autoSaveTimer);
        }
        this._autoSaveTimer = setTimeout(() => {
            this._autoSaveLayout();
        }, 1000); // 1 second debounce
    }

    /**
     * Auto-save the current layout to the active dashboard.
     * @private
     */
    _autoSaveLayout() {
        if (!this.tileGrid || !this.currentScenarioId) return;

        const activeConfig = this.layoutPersistence.getActiveConfiguration(this.currentScenarioId);
        if (!activeConfig) return;

        const layout = this.tileGrid.getLayout();

        // Update the existing dashboard layout (don't create a new one)
        this.layoutPersistence.updateConfiguration(this.currentScenarioId, activeConfig.id, layout);
    }

    /**
     * Rename the currently active dashboard using inline renamer.
     * @private
     */
    _renameActiveDashboard() {
        const activeConfig = this.layoutPersistence.getActiveConfiguration(this.currentScenarioId);
        if (!activeConfig) {
            console.warn('[ResultsTileDashboard] No active config, cannot rename');
            return;
        }

        const nameEl = this._toolbarHeader?.querySelector('.dashboard-name');
        if (!nameEl) return;

        // Destroy any existing renamer
        if (this._dashboardRenamer) {
            this._dashboardRenamer.destroy();
            this._dashboardRenamer = null;
        }

        // Use InlineRenamer for inline editing
        this._dashboardRenamer = attachInlineRenamer({
            label: nameEl,
            initialValue: activeConfig.name,
            inputClass: 'dashboard-name-input',
            onCommit: (newName) => {
                if (newName && newName.trim() && newName !== activeConfig.name) {
                    // renameConfiguration returns the actual name used (may differ if duplicate)
                    const actualName = this.layoutPersistence.renameConfiguration(this.currentScenarioId, activeConfig.id, newName.trim());
                    return { success: true, newValue: actualName || newName.trim() };
                }
                return { success: true, newValue: activeConfig.name };
            },
            onFinish: () => {
                this._dashboardRenamer = null;
            },
            onCancel: () => {
                this._dashboardRenamer = null;
            }
        });

        this._dashboardRenamer.start();
    }

    /**
     * Delete the currently active dashboard (if more than one exists).
     * @private
     */
    async _deleteActiveDashboard() {
        const configs = this.layoutPersistence.listConfigurations(this.currentScenarioId);
        if (configs.length <= 1) {
            return; // Cannot delete the last dashboard - button should be disabled
        }

        const activeConfig = this.layoutPersistence.getActiveConfiguration(this.currentScenarioId);
        if (!activeConfig) return;

        const confirmed = await showDeleteConfirmDialog({
            itemName: activeConfig.name,
            itemType: 'dashboard',
        });
        if (!confirmed) return;

        this.layoutPersistence.deleteConfiguration(this.currentScenarioId, activeConfig.id);

        // Load the first remaining dashboard
        const remaining = this.layoutPersistence.listConfigurations(this.currentScenarioId);
        if (remaining.length > 0) {
            this._loadDashboard(remaining[0].id);
        }

        this._refreshToolbar();
    }

    /**
     * Save the current layout to the active dashboard.
     * @private
     */
    _saveCurrentDashboard() {
        if (!this.tileGrid || !this.currentScenarioId) {
            console.warn('[ResultsTileDashboard] Cannot save: missing tileGrid or scenarioId');
            return;
        }

        const activeConfig = this.layoutPersistence.getActiveConfiguration(this.currentScenarioId);
        const layout = this.tileGrid.getLayout();

        if (activeConfig) {
            // Update existing dashboard (don't create a new one)
            this.layoutPersistence.updateConfiguration(this.currentScenarioId, activeConfig.id, layout);
        } else {
            // Create new default dashboard
            const configId = this.layoutPersistence.saveConfiguration(this.currentScenarioId, 'Default', layout);
            this.layoutPersistence.setActiveConfiguration(this.currentScenarioId, configId);
        }

        // Show brief save confirmation
        this._showSaveConfirmation();
    }

    /**
     * Show a brief save confirmation indicator.
     * @private
     */
    _showSaveConfirmation() {
        const saveBtn = this._toolbarHeader?.querySelector('.btn-save-layout');
        if (!saveBtn) return;

        saveBtn.classList.add('saved');
        setTimeout(() => saveBtn.classList.remove('saved'), 1000);
    }

    /**
     * Load a dashboard by ID.
     * @param {string} configId
     * @private
     */
    _loadDashboard(configId) {
        if (!this.currentScenarioId || !this.tileGrid) return;

        const config = this.layoutPersistence.loadConfiguration(this.currentScenarioId, configId);
        if (!config) return;

        // Set as active configuration
        this.layoutPersistence.setActiveConfiguration(this.currentScenarioId, configId);

        // When showing sample data, re-upgrade for the new dashboard's template
        // so variable names in the data match what its tiles reference
        if (this._showingSampleData) {
            this._upgradeSampleDataForTemplate(config.templateId, config.tiles);
            this._clearStaleVariableRefs(config.tiles, this.currentData);
            this._updateVariableDropdown();
        }

        this.tileGrid.setLayout({ tiles: config.tiles, version: config.version });

        const filteredData = this._filterData(this.currentData, this._selectedNamespace, this._selectedVariable);
        this.tileGrid.fullData = this.currentData;
        this.tileGrid.setData(filteredData);
        this._refreshToolbar();
    }

    /**
     * Populate the dashboard selector dropdown.
     * @param {HTMLElement} dropdown
     * @private
     */
    _populateDashboardSelector(dropdown) {
        if (!dropdown || !this.currentScenarioId) return;

        const configs = this.layoutPersistence.listConfigurations(this.currentScenarioId);

        if (configs.length === 0) {
            dropdown.innerHTML = '<div class="dropdown-empty">No dashboards</div>';
            return;
        }

        dropdown.innerHTML = `
            ${configs.map(cfg => `
                <button class="dropdown-item dashboard-item ${cfg.isActive ? 'is-active' : ''}" data-config-id="${cfg.id}">
                    <span class="material-symbols-outlined">${cfg.isActive ? 'check' : 'dashboard'}</span>
                    <span class="dashboard-item-name">${this._escapeHtml(cfg.name)}</span>
                </button>
            `).join('')}
            <div class="dropdown-divider"></div>
            <button class="dropdown-item btn-new-dashboard">
                <span class="material-symbols-outlined">add</span>
                <span>New Dashboard</span>
            </button>
        `;

        // Wire up dashboard selection
        dropdown.querySelectorAll('.dashboard-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const configId = item.dataset.configId;
                this._loadDashboard(configId);
                this._closeDashboardSelector(dropdown, dropdown.previousElementSibling);
            });
        });

        // Wire up new dashboard button
        dropdown.querySelector('.btn-new-dashboard')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this._createNewDashboard();
            this._closeDashboardSelector(dropdown, dropdown.previousElementSibling);
        });
    }

    /**
     * Create a new dashboard via the template selection window.
     * @private
     */
    _createNewDashboard() {
        // Legacy stub — dashboard creation moved to SimulationDashboardTab
        this.logger?.warn?.('_createNewDashboard is deprecated');
    }

    /**
     * Toggle dashboard selector dropdown.
     * @param {HTMLElement} dropdown
     * @param {HTMLElement} btn
     * @private
     */
    _toggleDashboardSelector(dropdown, btn) {
        if (!dropdown) return;
        const isHidden = dropdown.hidden;
        dropdown.hidden = !isHidden;
        btn?.classList.toggle('is-open', isHidden);
        if (isHidden) {
            this._populateDashboardSelector(dropdown);
            ActionDropdown.position(btn, dropdown);
        }
    }

    /**
     * Close dashboard selector dropdown.
     * @param {HTMLElement} dropdown
     * @param {HTMLElement} btn
     * @private
     */
    _closeDashboardSelector(dropdown, btn) {
        if (dropdown) dropdown.hidden = true;
        btn?.classList.remove('is-open');
    }

    /**
     * Refresh the entire toolbar (after dashboard changes).
     * @private
     */
    _refreshToolbar() {
        if (!this._toolbarHeader) return;

        const configs = this.layoutPersistence.listConfigurations(this.currentScenarioId);
        const activeConfig = this.layoutPersistence.getActiveConfiguration(this.currentScenarioId);
        const canDelete = configs.length > 1;

        // Update dashboard name
        const nameEl = this._toolbarHeader.querySelector('.dashboard-name');
        if (nameEl) {
            nameEl.textContent = activeConfig?.name || 'Default';
        }

        // Update delete button state
        const deleteBtn = this._toolbarHeader.querySelector('.btn-delete-dashboard');
        if (deleteBtn) {
            deleteBtn.disabled = !canDelete;
        }

        // Update selector dropdown
        const selectorDropdown = this._toolbarHeader.querySelector('.dashboard-selector-dropdown');
        if (selectorDropdown) {
            this._populateDashboardSelector(selectorDropdown);
        }

        // Update namespace dropdown
        this._updateNamespaceDropdown();
    }

    /**
     * Update the namespace selector dropdown with current namespaces.
     * @private
     */
    _updateNamespaceDropdown() {
        if (!this._toolbarHeader) return;

        const container = this._toolbarHeader.querySelector('.toolbar-left');
        if (!container) return;

        // Remove existing namespace selector
        const existing = container.querySelector('.namespace-selector-group');
        existing?.remove();

        // If no namespaces, don't render the dropdown
        if (!this._namespaces || this._namespaces.length === 0) return;

        // Create new namespace selector
        const selectorHtml = `
            <div class="toolbar-group namespace-selector-group">
                <span class="material-symbols-outlined toolbar-icon">folder</span>
                <select class="namespace-selector-dropdown has-tooltip" data-tooltip="Filter by namespace">
                    <option value="All" ${this._selectedNamespace === 'All' ? 'selected' : ''}>All</option>
                    ${this._namespaces.map(ns => `
                        <option value="${ns}" ${ns === this._selectedNamespace ? 'selected' : ''}>
                            ${this._escapeHtml(ns)}
                        </option>
                    `).join('')}
                </select>
            </div>
        `;

        // Insert after dashboard-info
        const dashboardInfo = container.querySelector('.dashboard-info');
        if (dashboardInfo) {
            dashboardInfo.insertAdjacentHTML('afterend', selectorHtml);

            // Wire up event
            const dropdown = container.querySelector('.namespace-selector-dropdown');
            dropdown?.addEventListener('change', (e) => {
                this._onNamespaceSelected(e.target.value);
            });
        }
    }

    /**
     * Extract variable names from analytics data, optionally filtered by namespace.
     * @param {Object} data - Analytics data
     * @param {string} namespace - Namespace to filter by, or 'All' for all variables
     * @returns {Array<string>} Sorted list of variable names
     * @private
     */
    _extractVariables(data, namespace = 'All') {
        const variables = new Set();

        const extractVariableName = (fullName) => {
            if (!fullName) return null;
            // For namespaced vars like "Tab_2.var_name" or "Main::Stock[Asset]", extract just the variable part
            let varName = fullName;
            if (fullName.includes('::')) {
                varName = fullName.split('::')[1] || fullName;
            } else if (fullName.includes('.')) {
                varName = fullName.split('.').slice(1).join('.') || fullName;
            }
            return varName;
        };

        const shouldInclude = (fullName) => {
            if (namespace === 'All') return true;
            // Check if variable belongs to the selected namespace
            return fullName.startsWith(namespace + '.') ||
                   fullName.startsWith(namespace + '::') ||
                   (fullName.includes('.') && fullName.split('.')[0] === namespace) ||
                   (fullName.includes('::') && fullName.split('::')[0].split('.')[0] === namespace);
        };

        const addVariable = (fullName) => {
            if (shouldInclude(fullName)) {
                const varName = extractVariableName(fullName);
                if (varName) variables.add(varName);
            }
        };

        // Extract from all variable categories
        if (data.stocks) Object.keys(data.stocks).forEach(addVariable);
        if (data.flows) Object.keys(data.flows).forEach(addVariable);
        if (data.indicators) Object.keys(data.indicators).forEach(addVariable);

        return Array.from(variables).sort();
    }

    /**
     * Update the variable selector dropdown with current variables.
     * @private
     */
    _updateVariableDropdown() {
        if (!this._toolbarHeader) return;

        const container = this._toolbarHeader.querySelector('.toolbar-left');
        if (!container) return;

        // Remove existing variable selector
        const existing = container.querySelector('.variable-selector-group');
        existing?.remove();

        // Extract variables based on current namespace
        this._variables = this._extractVariables(this.currentData, this._selectedNamespace);

        // If no variables, don't render the dropdown
        if (!this._variables || this._variables.length === 0) return;

        // Create new variable selector
        const selectorHtml = `
            <div class="toolbar-group variable-selector-group">
                <span class="material-symbols-outlined toolbar-icon">data_object</span>
                <select class="variable-selector-dropdown has-tooltip" data-tooltip="Filter by variable">
                    <option value="All" ${this._selectedVariable === 'All' ? 'selected' : ''}>All</option>
                    ${this._variables.map(v => `
                        <option value="${v}" ${v === this._selectedVariable ? 'selected' : ''}>
                            ${this._escapeHtml(formatVariableLabel(v))}
                        </option>
                    `).join('')}
                </select>
            </div>
        `;

        // Insert after namespace selector (or after dashboard-info if namespace doesn't exist)
        const namespaceSelector = container.querySelector('.namespace-selector-group');
        const dashboardInfo = container.querySelector('.dashboard-info');
        const insertAfter = namespaceSelector || dashboardInfo;

        if (insertAfter) {
            insertAfter.insertAdjacentHTML('afterend', selectorHtml);

            // Wire up event
            const dropdown = container.querySelector('.variable-selector-dropdown');
            dropdown?.addEventListener('change', (e) => {
                this._onVariableSelected(e.target.value);
            });
        }
    }

    /**
     * Refresh add-widget dropdown options (e.g. after run type changes).
     * @private
     */
    _refreshAddWidgetOptions() {
        if (!this._addWidgetDropdown) return;
        const runType = this.currentData?.meta?.type || 'static';
        const catalog = getWidgetCatalog({ runType });
        this._addWidgetDropdown.setOptions(
            catalog.map(w => ({ type: w.type, label: w.title, icon: w.icon, description: w.description }))
        );
    }

    // =========================================================================
    // CONFIGURATION MANAGEMENT
    // =========================================================================

    /**
     * Handle scenario selection change.
     * @param {string} scenarioId - Selected scenario ID
     * @private
     */
    async _onScenarioSelected(scenarioId) {
        if (scenarioId === this.currentScenarioId) return;

        window.logger?.nodes('[ResultsTileDashboard] Scenario selected:', scenarioId);

        // Re-render with the new scenario
        if (this.container) {
            await this.render(scenarioId, this.container);
        }

        // Notify scenario page if available to sync selection
        if (this.eventBus) {
            this.eventBus.emit('dashboard:scenario-changed', { scenarioId });
        }
    }

    /**
     * Handle run selection change.
     * @param {string} runId - Selected run ID
     * @private
     */
    async _onRunSelected(runId) {
        if (runId === this._selectedRunId) return;

        this._selectedRunId = runId;
        window.logger?.nodes('[ResultsTileDashboard] Run selected:', runId);

        // Show loading in grid
        if (this.tileGrid) {
            // Load data for the selected run
            await this._loadRunData(runId);

            if (this.currentData) {
                this.tileGrid.fullData = this.currentData;
                this.tileGrid.setData(this.currentData);
            }
        }
    }

    /**
     * Load data for a specific run.
     * @param {string} runId - Run ID to load
     * @private
     */
    async _loadRunData(runId) {
        try {
            const ecosimNew = window.__ECOSIM_JS_NEW__;
            const hostBridge = ecosimNew?.hostBridge || window.pywebview?.api;

            if (hostBridge?.sim_get_scenario_result) {
                const response = await hostBridge.sim_get_scenario_result({
                    runId,
                    scenarioId: this.currentScenarioId
                });

                if (response?.ok) {
                    // Transform to analytics format
                    const controller = ecosimNew?.simulationController;
                    if (controller) {
                        // Use the controller's transform method if accessible
                        const analytics = this._transformResultToAnalytics(response);
                        this.currentData = analytics;
                    } else {
                        // Fallback: use response directly if already in analytics format
                        this.currentData = response.analytics || response;
                    }
                    return;
                }
            }

            window.logger?.warn('nodes', '[ResultsTileDashboard] Failed to load run data');
        } catch (err) {
            window.logger?.warn('nodes', '[ResultsTileDashboard] Error loading run data:', err);
        }
    }

    /**
     * Transform backend result to analytics format (simplified version).
     * @param {Object} response - Backend response
     * @returns {Object|null} Analytics object
     * @private
     */
    _transformResultToAnalytics(response) {
        const { headers = [], rows = [], summary = {} } = response;

        if (!headers.length || !rows.length) {
            return null;
        }

        // Extract time values
        const time = rows.map(row => {
            const tDisp = row.tDisp;
            const num = parseFloat(tDisp);
            return isNaN(num) ? tDisp : num;
        });

        // Parse header to extract category, variable name, and metric
        const parseHeader = (header) => {
            const prefixMatch = header.match(/^(stock|flow|indicator):(.+)$/i);
            if (!prefixMatch) {
                return { category: 'stock', varName: header, metric: 'mean' };
            }

            const category = prefixMatch[1].toLowerCase();
            let remainder = prefixMatch[2];

            const metricMatch = remainder.match(/^(.+?)\s*\(([^)]+)\)$/);
            if (metricMatch) {
                return {
                    category,
                    varName: metricMatch[1].trim(),
                    metric: metricMatch[2].toLowerCase()
                };
            }

            return { category, varName: remainder, metric: 'mean' };
        };

        const stocks = {};
        const flows = {};
        const indicators = {};
        const categoryMap = { stock: stocks, flow: flows, indicator: indicators };
        let isMonteCarlo = false;

        // The "time" header occupies index 0 in headers but time data is in
        // row.tDisp, not in row.cols.  Track how many headers to skip so that
        // subsequent column lookups into row.cols use the correct offset.
        let colOffset = 0;
        headers.forEach((header, headerIndex) => {
            if (header.toLowerCase() === 'time') {
                colOffset++;
                return;
            }

            const { category, varName, metric } = parseHeader(header);
            const targetMap = categoryMap[category] || stocks;

            const dataColIndex = headerIndex - colOffset;
            const values = rows.map(row => {
                const val = row.cols?.[dataColIndex];
                if (val === null || val === undefined || val === '') return null;
                const num = parseFloat(val);
                return isNaN(num) ? val : num;
            });

            if (metric !== 'mean' || (targetMap[varName] && !Array.isArray(targetMap[varName]))) {
                isMonteCarlo = true;
            }

            if (!targetMap[varName]) {
                targetMap[varName] = {};
            }

            if (typeof targetMap[varName] === 'object' && !Array.isArray(targetMap[varName])) {
                targetMap[varName][metric] = values;
            } else {
                targetMap[varName] = { [metric]: values };
            }
        });

        // Finalize structure
        const finalizeCategory = (category) => {
            for (const varName of Object.keys(category)) {
                const data = category[varName];
                if (typeof data === 'object' && !Array.isArray(data)) {
                    const metrics = Object.keys(data);
                    if (!isMonteCarlo && metrics.length === 1 && metrics[0] === 'mean') {
                        category[varName] = data.mean;
                    }
                }
            }
        };

        finalizeCategory(stocks);
        finalizeCategory(flows);
        finalizeCategory(indicators);

        const analytics = {
            time,
            stocks,
            flows,
            indicators,
            meta: {
                type: isMonteCarlo ? 'monte-carlo' : 'static',
                steps: time.length,
                timeStart: time[0],
                timeEnd: time[time.length - 1],
                stockCount: Object.keys(stocks).length,
                flowCount: Object.keys(flows).length,
                indicatorCount: Object.keys(indicators).length,
                runId: response.runId,
                scenarioId: response.scenarioId,
                scenarioName: response.scenarioName,
            }
        };

        // Include jacobian and convergence data from summary if available
        // These are computed during Monte Carlo runs and persisted with the result
        if (summary.jacobian) {
            analytics.jacobian = summary.jacobian;
        }
        if (summary.convergence) {
            analytics.convergence = summary.convergence;
        }
        // Also include meta from summary (num_runs, etc.)
        if (summary.meta) {
            analytics.meta = { ...analytics.meta, ...summary.meta };
        }

        return analytics;
    }

    /**
     * Load analytics data for current scenario.
     * @private
     */
    async _loadData() {
        try {
            // If we have a selected run from _loadAvailableRuns, prioritize loading it from the backend
            // This ensures historical runs are properly loaded
            if (this._selectedRunId) {
                window.logger?.nodes('[ResultsTileDashboard] Loading selected run:', this._selectedRunId);
                await this._loadRunData(this._selectedRunId);
                if (this.currentData && Object.keys(this.currentData).length > 0) {
                    return;
                }
            }

            // Try to get cached data from existing dashboard
            if (window.resultsDashboard) {
                const cached = window.resultsDashboard.getAnalytics?.(this.currentScenarioId);
                if (cached && Object.keys(cached).length > 0) {
                    this.currentData = cached;
                    return;
                }
            }

            // Try new architecture via __ECOSIM_JS_NEW__
            const ecosimNew = window.__ECOSIM_JS_NEW__;
            if (ecosimNew) {
                // Check dataManager metadata for persisted results
                const dataManager = ecosimNew.dataManager;
                if (dataManager?.metadata?.lastSimulationResult?.analytics) {
                    this.currentData = dataManager.metadata.lastSimulationResult.analytics;
                    return;
                }

                // Check controller state
                const controller = ecosimNew.simulationController;
                if (controller?.state?.result?.analytics) {
                    this.currentData = controller.state.result.analytics;
                    return;
                }
            }

            // Load from simulation manager (legacy)
            if (window.simulationManager) {
                const result = await window.simulationManager.loadLastResult?.({ silent: true });
                if (result && result.analytics) {
                    this.currentData = result.analytics;

                    // Also cache in existing dashboard
                    window.resultsDashboard?.cacheAnalytics?.(this.currentScenarioId, result.analytics);
                    return;
                }
            }

            this.currentData = null;
        } catch (err) {
            window.logger?.warn('nodes', '[ResultsTileDashboard] Failed to load data:', err);
            this.currentData = null;
        }
    }

    /**
     * Render empty state when no data is available.
     * @param {HTMLElement} container
     * @private
     */
    _renderEmptyState(container) {
        container.innerHTML = `
            <div class="results-empty-state">
                <div class="empty-icon">
                    <span class="material-symbols-outlined">bar_chart</span>
                </div>
                <p>No simulation results available</p>
                <p class="empty-hint">Run a simulation to see analytics</p>
            </div>
        `;
    }

    /**
     * Generate sample analytics data for dashboard preview when no simulation has run.
     * Produces a static-type dataset with smooth growth/decay curves.
     * @returns {Object} Analytics data matching the standard structure
     * @private
     */
    _generateSampleData() {
        const steps = 50;
        const time = Array.from({ length: steps }, (_, i) => i);

        const curve = (base, rate) => time.map(t => base * Math.exp(rate * t / steps));
        const sine = (base, amp, freq) => time.map(t => base + amp * Math.sin(freq * t / steps * Math.PI * 2));
        const logistic = (cap, rate, mid) => time.map(t => cap / (1 + Math.exp(-rate * (t - mid))));

        return {
            time,
            stocks: {
                'Sample.Population': logistic(1000, 0.2, 25),
                'Sample.Capital': curve(500, 0.8),
                'Sample.Resources': curve(800, -0.3),
            },
            flows: {
                'Sample.Growth': sine(20, 8, 2),
                'Sample.Investment': curve(10, 0.6),
            },
            indicators: {
                'Sample.Productivity': sine(50, 15, 1.5),
            },
            meta: { type: 'static' },
            summary: {
                steps,
                timeStart: 0,
                timeEnd: steps - 1,
                stockCount: 3,
                flowCount: 2,
                indicatorCount: 1,
            },
        };
    }

    /**
     * When showing sample data, upgrade to the template's demo profile so
     * variable names in the data match what the template's tiles reference.
     * Tries multiple template sources and validates that the demo data
     * contains the variables referenced by the current tiles.
     * @param {string} templateId - Template ID to look up the demo profile
     * @param {Array} [tiles] - Tile configs to validate against
     * @private
     */
    _upgradeSampleDataForTemplate(templateId, tiles) {
        if (!this._showingSampleData) return;

        // Build ordered list of candidate template IDs (deduped)
        const candidates = [];
        const seen = new Set();
        const addCandidate = (id) => {
            if (id && !seen.has(id)) {
                seen.add(id);
                candidates.push(id);
            }
        };

        addCandidate(templateId);
        addCandidate(this.layoutPersistence.getTemplateId(this.currentScenarioId));
        addCandidate(TemplateRegistry.resolve(this.currentScenario)?.id);

        // Collect variable references from tile configs to validate data match
        const tileVarRefs = this._collectTileVariableRefs(tiles);

        // Try each candidate: pick the first whose demo data covers the tile refs
        for (const candidateId of candidates) {
            const template = TemplateRegistry.get(candidateId);
            if (!template?.demoDataProfile) continue;

            const demoData = getDemoData(template.demoDataProfile);
            if (!demoData) continue;

            // If tiles have variable refs, verify the demo data contains them
            if (tileVarRefs.length > 0 && !this._demoDataCoversRefs(demoData, tileVarRefs)) {
                continue;
            }

            this.currentData = demoData;
            this._namespaces = this._extractNamespaces(this.currentData);
            this._selectedNamespace = this._restoreNamespaceSelection();
            this._variables = this._extractVariables(this.currentData, this._selectedNamespace);
            return;
        }

        // No candidate matched — use the first available demo data as fallback
        for (const candidateId of candidates) {
            const template = TemplateRegistry.get(candidateId);
            if (!template?.demoDataProfile) continue;
            const demoData = getDemoData(template.demoDataProfile);
            if (!demoData) continue;

            this.currentData = demoData;
            this._namespaces = this._extractNamespaces(this.currentData);
            this._selectedNamespace = this._restoreNamespaceSelection();
            this._variables = this._extractVariables(this.currentData, this._selectedNamespace);
            return;
        }
    }

    /**
     * Collect variable name references from tile configs.
     * @param {Array} [tiles] - Tile descriptors with config objects
     * @returns {string[]} Unique variable names referenced by tiles
     * @private
     */
    _collectTileVariableRefs(tiles) {
        if (!tiles) return [];

        const varKeys = ['variable', 'xVariable', 'yVariable', 'stock', 'selectedVariable', 'outputVariable'];
        const refs = new Set();
        for (const tile of tiles) {
            const config = tile.config || {};
            for (const key of varKeys) {
                if (typeof config[key] === 'string' && config[key]) {
                    refs.add(config[key]);
                }
            }
        }
        return Array.from(refs);
    }

    /**
     * Check whether demo data contains at least one of the referenced variables.
     * @param {Object} demoData - Analytics-shaped data
     * @param {string[]} refs - Variable names to look for
     * @returns {boolean}
     * @private
     */
    _demoDataCoversRefs(demoData, refs) {
        const allVars = new Set([
            ...Object.keys(demoData.stocks || {}),
            ...Object.keys(demoData.flows || {}),
            ...Object.keys(demoData.indicators || {}),
        ]);
        return refs.some(ref => allVars.has(ref));
    }

    /**
     * Show the sample-data badge in the toolbar.
     * @private
     */
    _showSampleDataBadge() {
        if (!this._toolbarHeader) return;
        // Avoid duplicates
        if (this._toolbarHeader.querySelector('.sample-data-badge')) return;

        const badge = document.createElement('div');
        badge.className = 'sample-data-badge';
        badge.innerHTML = `
            <span class="material-symbols-outlined">science</span>
            <span>Sample data</span>
        `;

        const toolbarRight = this._toolbarHeader.querySelector('.toolbar-right');
        if (toolbarRight) {
            toolbarRight.prepend(badge);
        }
    }

    /**
     * Remove the sample-data badge from the toolbar.
     * @private
     */
    _removeSampleDataBadge() {
        this._toolbarHeader?.querySelector('.sample-data-badge')?.remove();
        this._showingSampleData = false;
    }

    /**
     * Clear variable references that point to sample data from all tile configs.
     * This lets widgets auto-select the first real variable on next render.
     * @private
     */
    _clearSampleVariableRefs() {
        if (!this.tileGrid?.tiles) return;

        for (const tile of this.tileGrid.tiles.values()) {
            this._stripSampleRefsFromConfig(tile.config);
        }
    }

    /**
     * Null out any Sample.* variable references in a single config object.
     * @param {Object} config - Tile config to clean
     * @private
     */
    _stripSampleRefsFromConfig(config) {
        const varKeys = ['variable', 'xVariable', 'yVariable', 'stock', 'selectedVariable'];
        for (const key of varKeys) {
            if (typeof config[key] === 'string' && config[key].startsWith('Sample.')) {
                config[key] = null;
            }
        }
    }

    /**
     * Clear variable references from tile configs that don't exist in the data.
     * Called when showing sample data to prevent "variable not found" errors
     * when the demo data profile doesn't match the tile template origin.
     * @param {Array} tiles - Layout tile descriptors
     * @param {Object} data - Current analytics data to validate against
     * @private
     */
    _clearStaleVariableRefs(tiles, data) {
        if (!tiles || !data) return;

        const allVars = new Set([
            ...Object.keys(data.stocks || {}),
            ...Object.keys(data.flows || {}),
            ...Object.keys(data.indicators || {}),
        ]);

        const varKeys = ['variable', 'xVariable', 'yVariable', 'stock', 'selectedVariable', 'outputVariable'];
        for (const tile of tiles) {
            const config = tile.config;
            if (!config) continue;
            for (const key of varKeys) {
                if (typeof config[key] === 'string' && config[key] && !allVars.has(config[key])) {
                    config[key] = null;
                }
            }
        }
    }

    /**
     * Strip Sample.* variable references from a layout's tile configs.
     * Called before applying a saved layout when real data is available.
     * @param {Array} tiles - Layout tile descriptors
     * @private
     */
    _stripSampleRefsFromLayout(tiles) {
        for (const tile of tiles) {
            if (tile.config) {
                this._stripSampleRefsFromConfig(tile.config);
            }
        }
    }

    /**
     * Attach event listeners for tile interactions.
     * @private
     */
    _attachTileEventListeners(element) {
        const target = element || this.container;
        if (!target) return;

        // Listen for tile config requests - show right panel
        target.addEventListener('tile:config-request', (e) => {
            const { tileId, tileType, config, schema } = e.detail;
            this._showConfigPanel(tileId, tileType, config, schema);
        });

        // Listen for tile remove requests
        target.addEventListener('tile:remove-request', async (e) => {
            const { tileId, anchorElement } = e.detail;

            // Use anchor from event, or find it
            let anchor = anchorElement;
            const confirmed = await showConfirmDialog({
                title: 'Remove Widget',
                message: 'Remove this widget from the dashboard?',
                icon: 'delete',
                okLabel: 'Remove',
                cancelLabel: 'Cancel',
                okVariant: 'danger',
            });

            if (confirmed) {
                this.tileGrid.removeTile(tileId);
                // Note: removeTile already calls _emitLayoutChanged which triggers autosave
            }
        });

    }

    /**
     * Initialize the SlideOutPanel + PanelController for widget configuration.
     * @param {HTMLElement} hostContainer  Container to mount the panel on.
     * @private
     */
    _initConfigPanel(hostContainer) {
        this._slideOutPanel = new SlideOutPanel({
            width: 700,
            onClose: () => this._onConfigPanelClosed(),
        });
        this._slideOutPanel.mount(hostContainer);

        if (!this._slideOutPanel.contentEl) {
            window.logger?.warn('nodes', '[ResultsTileDashboard] SlideOutPanel mount failed');
            return;
        }

        // Initialize PanelController for widget configuration
        this.panelController = new PanelController({
            eventBus: this.eventBus,
            logger: window.logger
        });
        this.panelController.initialize({ container: this._slideOutPanel.contentEl });
    }

    /**
     * Wire panel controller events for config changes.
     * @private
     */
    _wirePanelEvents() {
        if (!this.eventBus) return;

        // Listen for input changes from PanelController
        // PanelController emits payload with: { nodeId, namespace, fieldId, descriptorKey, value, immediate }
        this.eventBus.on('panel:input:changed', (payload) => {
            if (!this._currentConfigTileId) return;

            // The config key is in descriptorKey (from field.key) or fieldId
            const key = payload.descriptorKey ?? payload.fieldId ?? payload.key;
            const { value } = payload;

            const tile = this.tileGrid?.tiles?.get(this._currentConfigTileId);
            if (!tile || !key) return;

            // Update tile config and re-render
            tile.config[key] = value;
            tile.update(this.currentData, tile.config);

            // Update layout config for persistence
            const layoutItem = this.tileGrid.layout.find(l => l.id === this._currentConfigTileId);
            if (layoutItem) {
                layoutItem.config = { ...tile.config };
            }
            // Trigger autosave to active dashboard configuration
            this._scheduleAutoSave();
        });
    }

    /**
     * Show the widget configuration panel.
     * @param {string} tileId - Tile ID
     * @param {string} tileType - Widget type
     * @param {Object} config - Current configuration
     * @param {Object} schema - Configuration schema
     * @private
     */
    _showConfigPanel(tileId, tileType, config, schema) {
        if (!this.panelController || !this._slideOutPanel) return;

        // Toggle behavior: if same tile, close panel
        if (this._currentConfigTileId === tileId) {
            this._closeConfigPanel();
            return;
        }

        // Remove highlight from previously selected tile
        if (this._currentConfigTileId) {
            const prevTile = this.tileGrid?.tiles?.get(this._currentConfigTileId);
            prevTile?.element?.classList.remove('tile--selected');
        }

        const tile = this.tileGrid?.tiles?.get(tileId);
        if (!tile) return;

        this._currentConfigTileId = tileId;

        // Highlight the selected tile
        tile.element?.classList.add('tile--selected');

        // Build descriptor from widget schema
        const descriptor = this._buildWidgetDescriptor(tileId, tileType, config, schema);

        // Open slide-out panel and render descriptor
        this._slideOutPanel.open('Widget Config', 'settings');
        this.panelController.renderDescriptor(descriptor);
    }

    /**
     * Close the configuration panel.
     * @private
     */
    _closeConfigPanel() {
        this._slideOutPanel?.close();
    }

    /**
     * Called when the slide-out panel closes (via close button, ESC, or backdrop click).
     * @private
     */
    _onConfigPanelClosed() {
        // Remove highlight from selected tile
        if (this._currentConfigTileId) {
            const tile = this.tileGrid?.tiles?.get(this._currentConfigTileId);
            tile?.element?.classList.remove('tile--selected');
        }
        this._currentConfigTileId = null;
        this.panelController?.clearPanel({ reason: 'closed' });
    }

    /**
     * Build a panel descriptor from widget schema.
     * @param {string} tileId - Tile ID
     * @param {string} tileType - Widget type name
     * @param {Object} config - Current config values
     * @param {Object} schema - Widget config schema
     * @returns {Object} Panel descriptor
     * @private
     */
    _buildWidgetDescriptor(tileId, tileType, config, schema) {
        const fields = (schema?.fields || []).map(field => {
            return this._schemaFieldToDescriptor(field, config);
        });

        return ConfigDescriptors.panel({
            nodeId: tileId,
            title: tileType,
            sections: [
                ConfigDescriptors.describeSection({
                    id: 'widget-config',
                    title: 'Settings',
                    fields
                })
            ]
        });
    }

    /**
     * Convert a schema field to a descriptor field.
     * @param {Object} field - Schema field definition
     * @param {Object} config - Current config values
     * @returns {Object} Descriptor field
     * @private
     */
    _schemaFieldToDescriptor(field, config) {
        const value = config[field.key];

        // Build options for select fields
        let options = null;
        if (field.type === 'select' || field.type === 'multiselect') {
            options = this._getFieldOptions(field);
        }

        switch (field.type) {
            case 'checkbox':
                return ConfigDescriptors.describeToggle({
                    key: field.key,
                    id: field.key,
                    label: field.label,
                    value: Boolean(value),
                    helperText: field.description,
                    emitsOnInput: true
                });

            case 'select':
                return ConfigDescriptors.describeSelect({
                    key: field.key,
                    id: field.key,
                    label: field.label,
                    value: value || '',
                    options: options,
                    helperText: field.description,
                    emitsOnInput: true
                });

            case 'number':
                return ConfigDescriptors.describeNumber({
                    key: field.key,
                    id: field.key,
                    label: field.label,
                    value: value ?? '',
                    min: field.min,
                    max: field.max,
                    step: field.step,
                    helperText: field.description,
                    emitsOnInput: true
                });

            case 'color':
                // Custom color input using describeCustom
                // skipLabel: false ensures standard config-label is rendered
                return ConfigDescriptors.describeCustom({
                    key: field.key,
                    id: field.key,
                    label: field.label,
                    value: value || '#2196F3',
                    helperText: field.description,
                    emitsOnInput: true,
                    skipLabel: false,
                    render: (container, fieldDescriptor) => {
                        this._renderColorField(container, fieldDescriptor);
                    }
                });

            case 'text':
            default:
                return ConfigDescriptors.describeInput({
                    key: field.key,
                    id: field.key,
                    label: field.label,
                    value: value || '',
                    placeholder: field.placeholder,
                    helperText: field.description,
                    emitsOnInput: true
                });
        }
    }

    /**
     * Render a color picker field.
     * Uses flat structure matching standard config-row layout (no nested panel-field wrapper).
     * @param {HTMLElement} container - Container element
     * @param {Object} context - Render context from PanelController: { field, nodeId, ... }
     * @private
     */
    _renderColorField(container, context) {
        // PanelController passes { field, nodeId, namespace, ... } - field descriptor is nested
        const field = context.field || context;
        const key = field.key || field.id;
        const value = field.value || '#2196F3';

        // Just render the color input directly - the label and hint are handled by the config-row wrapper
        const colorPicker = document.createElement('input');
        colorPicker.type = 'color';
        colorPicker.className = 'color-picker';
        colorPicker.value = value;

        colorPicker.addEventListener('input', (e) => {
            const newValue = e.target.value;
            // Emit change event with descriptorKey to match PanelController format
            this.eventBus?.emit('panel:input:changed', { descriptorKey: key, value: newValue });
        });

        container.appendChild(colorPicker);
    }

    /**
     * Get options for a select field.
     * @param {Object} field - Schema field
     * @returns {Array} Options array
     * @private
     */
    _getFieldOptions(field) {
        // If field has static options array
        if (Array.isArray(field.options)) {
            return field.options.map(opt => {
                if (typeof opt === 'string') {
                    return { value: opt, label: opt };
                }
                return opt;
            });
        }

        // If field references variables from data (options: 'variables' or optionsFrom: 'variables')
        const wantsVariables = field.options === 'variables' || field.optionsFrom === 'variables';
        if (wantsVariables && this.currentData) {
            const options = [];

            // Add stocks
            if (this.currentData.stocks) {
                Object.keys(this.currentData.stocks).forEach(name => {
                    options.push({ value: name, label: `${name} (stock)` });
                });
            }

            // Add flows
            if (this.currentData.flows) {
                Object.keys(this.currentData.flows).forEach(name => {
                    options.push({ value: name, label: `${name} (flow)` });
                });
            }

            // Add indicators
            if (this.currentData.indicators) {
                Object.keys(this.currentData.indicators).forEach(name => {
                    options.push({ value: name, label: `${name} (indicator)` });
                });
            }

            return options;
        }

        // Namespace options extracted from variable key prefixes
        if (field.options === 'namespaces' && this.currentData) {
            const namespaces = new Set();
            const sources = [this.currentData.stocks, this.currentData.flows, this.currentData.indicators];
            for (const source of sources) {
                if (!source) continue;
                for (const key of Object.keys(source)) {
                    const dotIdx = key.indexOf('.');
                    if (dotIdx > 0) namespaces.add(key.slice(0, dotIdx));
                }
            }
            if (namespaces.size === 0) namespaces.add('Main');
            return Array.from(namespaces).sort().map(ns => ({ value: ns, label: ns }));
        }

        return [];
    }

    /**
     * Show the "Add Widget" menu.
     * @private
     */
    _showAddWidgetMenu() {
        const runType = this.currentData?.meta?.type || 'static';
        const catalog = getWidgetCatalog({ runType });

        // Create menu overlay
        const overlay = document.createElement('div');
        overlay.className = 'add-widget-overlay';

        const menu = document.createElement('div');
        menu.className = 'add-widget-menu';
        menu.innerHTML = `
            <div class="add-widget-header">
                <h3>Add Widget</h3>
                <button class="add-widget-close has-tooltip" data-tooltip="Close">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="add-widget-grid"></div>
        `;

        const grid = menu.querySelector('.add-widget-grid');

        catalog.forEach(widget => {
            const item = document.createElement('div');
            item.className = 'add-widget-item';
            item.innerHTML = `
                <span class="material-symbols-outlined">${widget.icon}</span>
                <span class="widget-title">${widget.title}</span>
                <span class="widget-description">${widget.description}</span>
            `;

            item.addEventListener('click', () => {
                this._addWidget(widget.type);
                overlay.remove();
            });

            grid.appendChild(item);
        });

        // Close handlers
        menu.querySelector('.add-widget-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        overlay.appendChild(menu);
        document.body.appendChild(overlay);

        // Escape key to close
        const keyHandler = (e) => {
            if (e.key === 'Escape') {
                overlay.remove();
                document.removeEventListener('keydown', keyHandler);
            }
        };
        document.addEventListener('keydown', keyHandler);
    }

    /**
     * Add a new widget to the grid.
     * @param {string} type - Widget type
     * @private
     */
    _addWidget(type) {
        if (!this.tileGrid) return;

        const WidgetClass = TileRegistry.get(type);
        if (!WidgetClass) {
            console.warn(`[ResultsTileDashboard] Unknown widget type: ${type}`);
            return;
        }

        // Generate unique ID
        const id = `${type}-${Date.now()}`;

        // Get default size
        const defaultSize = WidgetClass.DEFAULT_SIZE || { w: 4, h: 3 };

        // Find available position
        const position = this._findAvailablePosition(defaultSize.w, defaultSize.h);

        // Add tile (type, position, config, id)
        this.tileGrid.addTile(type, {
            x: position.x,
            y: position.y,
            w: defaultSize.w,
            h: defaultSize.h
        }, {}, id);
    }

    /**
     * Find an available position for a new tile.
     * @param {number} w - Tile width
     * @param {number} h - Tile height
     * @returns {{x: number, y: number}} Position
     * @private
     */
    _findAvailablePosition(w, h) {
        const layout = this.tileGrid.getLayout();
        const occupiedCells = new Set();

        // Handle both array and object with tiles property
        const tilesArray = Array.isArray(layout) ? layout : (layout?.tiles || []);

        // Mark occupied cells
        tilesArray.forEach(tile => {
            for (let x = tile.x; x < tile.x + tile.w; x++) {
                for (let y = tile.y; y < tile.y + tile.h; y++) {
                    occupiedCells.add(`${x},${y}`);
                }
            }
        });

        // Find first available position
        for (let y = 0; y < 100; y++) {
            for (let x = 0; x <= 12 - w; x++) {
                let available = true;
                for (let dx = 0; dx < w && available; dx++) {
                    for (let dy = 0; dy < h && available; dy++) {
                        if (occupiedCells.has(`${x + dx},${y + dy}`)) {
                            available = false;
                        }
                    }
                }
                if (available) {
                    return { x, y };
                }
            }
        }

        // Fallback: place at bottom
        const maxY = Math.max(...tilesArray.map(t => t.y + t.h), 0);
        return { x: 0, y: maxY };
    }

    /**
     * Handle layout changes.
     * @param {Object} layout - New layout
     * @private
     */
    _onLayoutChange(layout) {
        this._scheduleAutoSave();
    }

    /**
     * Save the current layout to the active dashboard configuration.
     * Prefer using _scheduleAutoSave() for debounced saves.
     * @private
     */
    _saveLayout() {
        if (!this.currentScenarioId || !this.tileGrid) return;
        // Trigger immediate autosave (bypasses debounce)
        this._autoSaveLayout();
    }

    /**
     * Reset layout to default.
     * @private
     */
    async _resetLayout() {
        if (!this.currentScenarioId || !this.tileGrid) return;

        const templateId = this.layoutPersistence.getTemplateId(this.currentScenarioId);
        const templateName = templateId ? (TemplateRegistry.get(templateId)?.name || 'template') : 'default template';

        const confirmed = await showConfirmDialog({
            title: 'Reset Layout',
            message: `Reset dashboard to ${templateName}? Current widget arrangement will be lost.`,
            icon: 'restart_alt',
            okLabel: 'Reset',
            cancelLabel: 'Cancel',
            okVariant: 'danger',
        });

        if (confirmed) {
            let layout = this.layoutPersistence.resetLayout(this.currentScenarioId, this.currentScenario);
            // Filter MC-only tiles for static runs
            if (this.currentData?.meta?.type !== 'monte-carlo' && layout?.tiles) {
                layout = {
                    ...layout,
                    tiles: layout.tiles.filter(tile => {
                        const WidgetClass = TileRegistry.get(tile.type);
                        return !WidgetClass?.REQUIRES_MC;
                    }),
                };
            }
            this.tileGrid.fullData = this.currentData;
            this.tileGrid.setLayout(layout);
            this.tileGrid.setData(this.currentData);
        }
    }

    /**
     * Open the template gallery modal.
     * @private
     */
    _openTemplateGallery() {
        const runType = this.currentScenario?.config?.type || this.currentData?.meta?.type || 'static';
        const scenarioTags = this.currentScenario?.config?.meta?.tags || this.currentScenario?.tags || [];

        openTemplateGallery({
            runType,
            scenarioTags,
            currentTemplateId: this.layoutPersistence.getTemplateId(this.currentScenarioId),
            onSelect: (template) => this._applyTemplate(template),
            onSaveAsTemplate: (name) => this.saveAsTemplate(name),
        });
    }

    /**
     * Apply a template to the current dashboard.
     * @param {Object} template - Template definition from registry
     * @private
     */
    _applyTemplate(template) {
        if (!this.currentScenarioId || !this.tileGrid) return;

        const instantiated = TemplateRegistry.instantiate(template);
        let layout = {
            tiles: instantiated.tiles,
            templateId: instantiated.templateId,
            templateModified: false,
        };

        // Filter MC-only tiles for static runs
        if (this.currentData?.meta?.type !== 'monte-carlo') {
            layout.tiles = layout.tiles.filter(tile => {
                const WidgetClass = TileRegistry.get(tile.type);
                return !WidgetClass?.REQUIRES_MC;
            });
        }

        // When showing sample data, upgrade to the template's demo profile
        this._upgradeSampleDataForTemplate(template.id, layout.tiles);

        // Save to simple layout storage (carries templateId)
        this.layoutPersistence.saveLayout(this.currentScenarioId, layout);

        // Also propagate templateId to the active dashboard config so it stays
        // consistent when auto-save later updates only the tiles
        const activeConfig = this.layoutPersistence.getActiveConfiguration(this.currentScenarioId);
        if (activeConfig) {
            this.layoutPersistence.updateConfigurationTemplateId(
                this.currentScenarioId, activeConfig.id, template.id
            );
        }

        this.tileGrid.fullData = this.currentData;
        this.tileGrid.setLayout(layout);
        this.tileGrid.setData(this.currentData);

        window.logger?.nodes(`[ResultsTileDashboard] Applied template: ${template.id}`);
    }

    /**
     * Save the current dashboard layout as a user template.
     * @param {string} name - Template name
     * @returns {string} The new template ID
     */
    saveAsTemplate(name) {
        if (!this.tileGrid) return null;

        const currentLayout = this.tileGrid.getLayout();
        const runType = this.currentData?.meta?.type || 'static';

        return TemplateRegistry.saveUserTemplate({
            name,
            description: `Custom template created from ${this.currentScenario?.name || 'scenario'}`,
            icon: 'dashboard_customize',
            category: runType === 'monte-carlo' ? 'uncertainty' : 'deterministic',
            compatibility: runType,
            tags: ['custom'],
            recommendedFor: { tags: [], priority: 5 },
            tiles: currentLayout.map(tile => ({
                type: tile.type,
                x: tile.x,
                y: tile.y,
                w: tile.w,
                h: tile.h,
                config: tile.config || {},
            })),
            demoDataProfile: runType === 'monte-carlo' ? 'generic-mc' : 'generic-static',
        });
    }

    /**
     * Export dashboard to scientific PDF report.
     * @param {string} format - 'pdf' or 'html'
     * @private
     */
    /**
     * Refresh the dashboard with new data.
     */
    async refresh() {
        if (!this.container || !this.currentScenarioId) return;

        await this._loadData();

        if (this.tileGrid && this.currentData) {
            this.tileGrid.fullData = this.currentData;
            this.tileGrid.setData(this.currentData);
        }
    }

    /**
     * Restore panel elements that were hidden for widget config mode.
     * Called when switching away from the scenario page to ensure
     * the flow/node page has all its panel elements visible.
     */
    restorePanelElements() {
        // Close config panel if open
        if (this._currentConfigTileId) {
            this._closeConfigPanel();
        } else {
            // Just restore elements if no config panel was open
            this._setWidgetConfigMode(false);
        }
    }

    // =========================================================================
    // SCENARIO COMPARISON
    // =========================================================================

    /**
     * Initialize the comparison data cache.
     * @private
     */
    _initComparisonCache() {
        if (this._comparisonCache) return;

        const ecosimNew = window.__ECOSIM_JS_NEW__;
        const hostBridge = ecosimNew?.hostBridge || window.pywebview?.api;

        if (hostBridge) {
            this._comparisonCache = new ComparisonDataCache({
                hostBridge,
                eventBus: this.eventBus,
            });
        }

        // Restore comparison selection from localStorage
        this._restoreComparisonSelection();
    }

    /**
     * Load available scenarios for comparison.
     * @private
     */
    async _loadAvailableScenarios() {
        this._availableScenarios = [];

        try {
            const ecosimNew = window.__ECOSIM_JS_NEW__;
            const hostBridge = ecosimNew?.hostBridge || window.pywebview?.api;

            if (hostBridge?.sim_list_scenarios) {
                const response = await hostBridge.sim_list_scenarios();
                if (response?.ok && response.scenarios) {
                    this._availableScenarios = response.scenarios
                        .filter(s => s.id !== this.currentScenarioId && s.runs?.length > 0)
                        .map(s => ({ id: s.id, name: s.name || s.id }));
                }
            }
        } catch (err) {
            window.logger?.warn('nodes', '[ResultsTileDashboard] Failed to load scenarios for comparison:', err);
        }
    }

    /**
     * Toggle comparison dropdown.
     * @param {HTMLElement} dropdown
     * @param {HTMLElement} btn
     * @private
     */
    _toggleCompareDropdown(dropdown, btn) {
        if (!dropdown) return;
        const isHidden = dropdown.hidden;
        dropdown.hidden = !isHidden;
        btn?.classList.toggle('is-open', isHidden);
        if (isHidden) {
            this._populateCompareDropdown(dropdown);
            ActionDropdown.position(btn, dropdown);
        }
    }

    /**
     * Close comparison dropdown.
     * @param {HTMLElement} dropdown
     * @param {HTMLElement} btn
     * @private
     */
    _closeCompareDropdown(dropdown, btn) {
        if (dropdown) dropdown.hidden = true;
        btn?.classList.remove('is-open');
    }

    /**
     * Populate comparison dropdown with available scenarios.
     * @param {HTMLElement} dropdown
     * @private
     */
    _populateCompareDropdown(dropdown) {
        if (!dropdown) return;

        if (this._availableScenarios.length === 0) {
            dropdown.innerHTML = '<div class="dropdown-empty">No other scenarios with results</div>';
            return;
        }

        const COMPARE_COLORS = ['#FF9800', '#9C27B0', '#009688', '#E91E63', '#3F51B5'];

        dropdown.innerHTML = `
            <div class="compare-dropdown-header">Compare with:</div>
            ${this._availableScenarios.slice(0, 5).map((s, idx) => {
                const isSelected = this._comparisonScenarioIds.includes(s.id);
                const color = COMPARE_COLORS[idx % COMPARE_COLORS.length];
                return `
                    <label class="dropdown-item compare-item ${isSelected ? 'is-selected' : ''}" data-scenario-id="${s.id}">
                        <span class="compare-color-dot" style="background:${color};"></span>
                        <input type="checkbox" ${isSelected ? 'checked' : ''} />
                        <span class="compare-item-name">${this._escapeHtml(s.name)}</span>
                    </label>
                `;
            }).join('')}
            ${this._comparisonScenarioIds.length > 0 ? `
                <div class="dropdown-divider"></div>
                <button class="dropdown-item btn-clear-comparison">
                    <span class="material-symbols-outlined">clear_all</span>
                    <span>Clear All</span>
                </button>
            ` : ''}
        `;

        // Wire up checkbox changes
        dropdown.querySelectorAll('.compare-item input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const item = e.target.closest('.compare-item');
                const scenarioId = item.dataset.scenarioId;
                if (e.target.checked) {
                    if (!this._comparisonScenarioIds.includes(scenarioId)) {
                        this._comparisonScenarioIds.push(scenarioId);
                    }
                    item.classList.add('is-selected');
                } else {
                    this._comparisonScenarioIds = this._comparisonScenarioIds.filter(id => id !== scenarioId);
                    item.classList.remove('is-selected');
                }

                this._comparisonEnabled = this._comparisonScenarioIds.length > 0;
                this._updateCompareButtonState();
                this._persistComparisonSelection();
                this._pushComparisonData();
            });
        });

        // Wire up clear all
        dropdown.querySelector('.btn-clear-comparison')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._comparisonScenarioIds = [];
            this._comparisonEnabled = false;
            this._updateCompareButtonState();
            this._persistComparisonSelection();
            this._pushComparisonData();
            this._populateCompareDropdown(dropdown);
        });
    }

    /**
     * Update the visual state of the Compare button.
     * @private
     */
    _updateCompareButtonState() {
        const btn = this._toolbarHeader?.querySelector('.btn-compare');
        if (btn) {
            btn.classList.toggle('is-active', this._comparisonEnabled);
        }
    }

    /**
     * Load comparison analytics and push to all comparison-capable tiles.
     * @private
     */
    async _pushComparisonData() {
        if (!this.tileGrid) return;

        // If no comparison scenarios selected, clear comparison data from all tiles
        if (!this._comparisonEnabled || this._comparisonScenarioIds.length === 0) {
            this.tileGrid.tiles.forEach(tile => {
                if (tile.constructor.SUPPORTS_COMPARISON) {
                    tile.setComparisonData(null);
                }
            });
            return;
        }

        if (!this._comparisonCache) return;

        const COMPARE_COLORS = ['#FF9800', '#9C27B0', '#009688', '#E91E63', '#3F51B5'];

        // Load analytics for each comparison scenario
        /** @type {Map<string, {name: string, analytics: Object, color: string}>} */
        const comparisonMap = new Map();

        for (let i = 0; i < this._comparisonScenarioIds.length; i++) {
            const scenarioId = this._comparisonScenarioIds[i];
            const scenario = this._availableScenarios.find(s => s.id === scenarioId);
            if (!scenario) continue;

            const analytics = await this._comparisonCache.getAnalytics(scenarioId);
            if (!analytics) continue;

            // Apply the same namespace/variable filter as the primary data
            const filteredAnalytics = this._filterData(analytics, this._selectedNamespace, this._selectedVariable);

            comparisonMap.set(scenarioId, {
                name: scenario.name,
                analytics: filteredAnalytics,
                color: COMPARE_COLORS[i % COMPARE_COLORS.length],
            });
        }

        // Push to all comparison-capable tiles
        const data = comparisonMap.size > 0 ? comparisonMap : null;
        this.tileGrid.tiles.forEach(tile => {
            if (tile.constructor.SUPPORTS_COMPARISON) {
                tile.setComparisonData(data);
            }
        });
    }

    /**
     * Persist comparison selection to localStorage.
     * @private
     */
    _persistComparisonSelection() {
        if (!this.currentScenarioId) return;
        try {
            const key = `ecosim.results.comparison.${this.currentScenarioId}`;
            localStorage.setItem(key, JSON.stringify(this._comparisonScenarioIds));
        } catch (err) {
            // Ignore storage errors
        }
    }

    /**
     * Restore comparison selection from localStorage.
     * @private
     */
    _restoreComparisonSelection() {
        if (!this.currentScenarioId) return;
        try {
            const key = `ecosim.results.comparison.${this.currentScenarioId}`;
            const saved = localStorage.getItem(key);
            if (saved) {
                const ids = JSON.parse(saved);
                if (Array.isArray(ids)) {
                    this._comparisonScenarioIds = ids;
                    this._comparisonEnabled = ids.length > 0;
                }
            }
        } catch (err) {
            // Ignore storage errors
        }
    }

    /**
     * Destroy the dashboard and clean up.
     */
    destroy() {
        // Close the config panel if open
        if (this._currentConfigTileId) {
            this._closeConfigPanel();
        }

        // Always restore hidden panel elements (even if config panel wasn't open)
        // This ensures elements are visible when switching back to flow page
        this._setWidgetConfigMode(false);

        this._addWidgetDropdown?.destroy();
        this._addWidgetDropdown = null;

        if (this._toolbarOutsideClick) {
            document.removeEventListener('click', this._toolbarOutsideClick);
            this._toolbarOutsideClick = null;
        }

        if (this.tileGrid) {
            this.tileGrid.destroy();
            this.tileGrid = null;
        }

        if (this.panelController) {
            this.panelController.dispose();
            this.panelController = null;
        }

        if (this._slideOutPanel) {
            this._slideOutPanel.dispose();
            this._slideOutPanel = null;
        }

        if (this._comparisonCache) {
            this._comparisonCache.clear();
            this._comparisonCache = null;
        }

        this._currentConfigTileId = null;
        this.container = null;
        this.currentScenarioId = null;
        this.currentData = null;
    }

    /**
     * Escape HTML special characters.
     * @param {string} str - String to escape
     * @returns {string} Escaped string
     * @private
     */
    _escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /**
     * Extract unique namespaces from analytics data.
     * @param {Object} data - Analytics data with stocks, flows, indicators
     * @returns {string[]} Sorted array of unique namespace names
     * @private
     */
    _extractNamespaces(data) {
        const namespaces = new Set();

        const extractFromName = (name) => {
            if (!name) return;
            // Format: "Tab_2.var_name" or "Main::Stock[Asset]"
            if (name.includes('::')) {
                // Extract part before ::, then split by . for namespace prefix
                const prefix = name.split('::')[0];
                const ns = prefix.includes('.') ? prefix.split('.')[0] : prefix;
                namespaces.add(ns);
            } else if (name.includes('.')) {
                namespaces.add(name.split('.')[0]);
            }
        };

        // Extract from all variable categories
        if (data.stocks) Object.keys(data.stocks).forEach(extractFromName);
        if (data.flows) Object.keys(data.flows).forEach(extractFromName);
        if (data.indicators) Object.keys(data.indicators).forEach(extractFromName);

        return Array.from(namespaces).sort();
    }

    /**
     * Filter analytics data by namespace.
     * @param {Object} data - Full analytics data
     * @param {string} namespace - Namespace to filter by, or 'All' for no filter
     * @param {string} variable - Variable name to filter by, or 'All' for no filter
     * @returns {Object} Filtered data
     * @private
     */
    _filterData(data, namespace, variable = 'All') {
        if (!data) return data;
        if (namespace === 'All' && variable === 'All') return data;

        const extractVariableName = (fullName) => {
            if (!fullName) return fullName;
            // For namespaced vars like "Tab_2.var_name" or "Main::Stock[Asset]", extract just the variable part
            if (fullName.includes('::')) {
                return fullName.split('::')[1] || fullName;
            } else if (fullName.includes('.')) {
                return fullName.split('.').slice(1).join('.') || fullName;
            }
            return fullName;
        };

        const filterCategory = (category) => {
            if (!category) return category;
            const filtered = {};
            Object.entries(category).forEach(([name, value]) => {
                // Check namespace filter
                let matchesNamespace = true;
                if (namespace !== 'All') {
                    matchesNamespace =
                        name.startsWith(namespace + '.') ||
                        name.startsWith(namespace + '::') ||
                        (name.includes('.') && name.split('.')[0] === namespace) ||
                        (name.includes('::') && name.split('::')[0].split('.')[0] === namespace);
                }

                // Check variable filter
                let matchesVariable = true;
                if (variable !== 'All') {
                    const varName = extractVariableName(name);
                    matchesVariable = varName === variable;
                }

                if (matchesNamespace && matchesVariable) {
                    filtered[name] = value;
                }
            });
            return filtered;
        };

        return {
            ...data,
            stocks: filterCategory(data.stocks),
            flows: filterCategory(data.flows),
            indicators: filterCategory(data.indicators)
        };
    }

    /**
     * Filter analytics data by namespace only (backwards compatibility wrapper).
     * @param {Object} data - Full analytics data
     * @param {string} namespace - Namespace to filter by, or 'All' for no filter
     * @returns {Object} Filtered data
     * @private
     */
    _filterDataByNamespace(data, namespace) {
        return this._filterData(data, namespace, 'All');
    }

    /**
     * Handle namespace selection change.
     * @param {string} namespace - Selected namespace
     * @private
     */
    _onNamespaceSelected(namespace) {
        this._selectedNamespace = namespace;
        this._persistNamespaceSelection(namespace);

        // Reset variable filter to 'All' when namespace changes
        this._selectedVariable = 'All';
        this._updateVariableDropdown();

        // Re-render widgets with filtered data
        if (this.tileGrid && this.currentData) {
            const filteredData = this._filterData(this.currentData, namespace, this._selectedVariable);
            this.tileGrid.fullData = this.currentData;
            this.tileGrid.setData(filteredData);
        }

        // Refresh comparison data with new filter
        if (this._comparisonEnabled) {
            this._pushComparisonData();
        }
    }

    /**
     * Handle variable selection change.
     * @param {string} variable - Selected variable name or 'All'
     * @private
     */
    _onVariableSelected(variable) {
        this._selectedVariable = variable;
        // Re-render widgets with filtered data
        if (this.tileGrid && this.currentData) {
            const filteredData = this._filterData(this.currentData, this._selectedNamespace, variable);
            this.tileGrid.fullData = this.currentData;
            this.tileGrid.setData(filteredData);
        }

        // Refresh comparison data with new filter
        if (this._comparisonEnabled) {
            this._pushComparisonData();
        }
    }

    /**
     * Persist the namespace selection to localStorage.
     * @param {string} namespace - Selected namespace
     * @private
     */
    _persistNamespaceSelection(namespace) {
        if (!this.currentScenarioId) return;
        try {
            const key = `ecosim.results.namespace.${this.currentScenarioId}`;
            localStorage.setItem(key, namespace);
        } catch (err) {
            window.logger?.warn?.('nodes', '[ResultsTileDashboard] Failed to persist namespace selection:', err);
        }
    }

    /**
     * Restore the namespace selection from localStorage.
     * @returns {string} Restored namespace or 'All'
     * @private
     */
    _restoreNamespaceSelection() {
        if (!this.currentScenarioId) return 'All';
        try {
            const key = `ecosim.results.namespace.${this.currentScenarioId}`;
            const saved = localStorage.getItem(key);
            // Only restore if the saved namespace exists in current data
            if (saved && (saved === 'All' || this._namespaces.includes(saved))) {
                return saved;
            }
        } catch (err) {
            window.logger?.warn?.('nodes', '[ResultsTileDashboard] Failed to restore namespace selection:', err);
        }
        return 'All';
    }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton ResultsTileDashboard instance.
 * @returns {ResultsTileDashboard}
 */
export function getResultsTileDashboard() {
    if (!instance) {
        instance = new ResultsTileDashboard();
        instance.init();
    }
    return instance;
}

// Export for global access
export default ResultsTileDashboard;
