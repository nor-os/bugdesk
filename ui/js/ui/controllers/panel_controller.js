/**
 * Panel Controller (js_new)
 * Location: ui/controllers/panel_controller.js
 *
 * Purpose
 * -------
 * Provide the right-panel host that renders node/component config descriptors and manages focus/collapsible lifecycle.
 *
 * Responsibilities
 * - Receive declarative config descriptors from nodes (via NodePlatform) and render them using shared widgets.
 * - Manage collapsible sections, validation states, and commit events back to nodes with namespace context.
 * - Ensure no business logic lives here—only rendering + event routing.
 *
 * Source Material
 * - html/js/ui_manager.js (right-panel handling).
 * - html/js/collapsible_manager.js (section lifecycle).
 * - html/js/node_input_binder.js & inline_* helpers (to be replaced by descriptor-driven rendering).
 */
import { ControllerBase } from '../base/controller_base.js';
import { ExpressionField } from '../components/expression_field.js';
import { SliderField } from '../components/slider_field.js';
import { AutocompleteField } from '../components/autocomplete_field.js';
import { ExpressionServices } from '../../utils/expression_services.js';

const EVENTS = Object.freeze({
    PANEL_READY: 'panel:ready',
    PANEL_CLEARED: 'panel:cleared',
    DESCRIPTOR_RENDERED: 'panel:descriptor:rendered',
    INPUT_CHANGED: 'panel:input:changed',
    ACTION_TRIGGERED: 'panel:action:triggered',
});

/**
 * Race a pywebview API call against a timeout. If the call hangs (stale callback
 * from pywebview page re-injection), reject with 'timeout' so callers can retry.
 */
function apiCallWithTimeout(promiseFn, timeoutMs = 4000) {
    return Promise.race([
        promiseFn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('api_timeout')), timeoutMs)),
    ]);
}

export class PanelController extends ControllerBase {
    constructor({ eventBus, dataManager, logger, componentRegistry = null, expressionServices = null } = {}) {
        super({ eventBus, dataManager, logger });
        this.componentRegistry = componentRegistry;
        this.expressionServices = expressionServices;
        this.container = null;
        this.currentDescriptor = null;
        this.activeNamespace = null;
        this.nodeId = null;
        this.sectionInstances = new Map();
        this.inputBindings = new Map();
        this.expressionFields = new Map();
        this.sliderFields = new Map();
        this._isInitialized = false;
        this._wiredDataEvents = false;
        this._editLocked = false;
    }

    /**
     * Lock or unlock panel editing. When locked, all inputs are disabled
     * and input change events are suppressed.
     * @param {boolean} locked
     */
    setEditLocked(locked) {
        this._editLocked = Boolean(locked);
        if (!this.container) return;
        this.container.classList.toggle('panel--edit-locked', this._editLocked);
        // Toggle inert to disable all interaction within the panel
        this.container.inert = this._editLocked;
    }

    initialize({ container, componentRegistry } = {}) {
        if (!container || typeof container.appendChild !== 'function') {
            throw new Error('PanelController.initialize requires a DOM container');
        }
        this.container = container;
        if (componentRegistry) {
            this.componentRegistry = componentRegistry;
        }
        this._renderEmptyState();
        this.#wireDataEvents();
        this._isInitialized = true;
        this.eventBus?.emit(EVENTS.PANEL_READY);
    }

    renderDescriptor(descriptor) {
        if (!this._isInitialized) {
            throw new Error('PanelController not initialized');
        }
        if (!descriptor || typeof descriptor !== 'object') {
            throw new TypeError('Panel descriptor must be an object');
        }

        this.currentDescriptor = descriptor;
        this.nodeId = descriptor.nodeId ?? null;
        this.activeNamespace = descriptor.namespace ?? null;
        this._clearPanel();
        const { shell, stack } = this._createPanelShell(descriptor);

        (descriptor.sections ?? []).forEach((section, index) => {
            const sectionEl = this._renderSection(section, index);
            stack.appendChild(sectionEl);
        });

        this.container.appendChild(shell);

        this.eventBus?.emit(EVENTS.DESCRIPTOR_RENDERED, {
            nodeId: descriptor.nodeId,
            namespace: descriptor.namespace,
            sections: descriptor.sections?.length ?? 0,
        });
    }

    clearPanel({ reason = 'unknown' } = {}) {
        this.currentDescriptor = null;
        this.nodeId = null;
        this.activeNamespace = null;
        this._clearPanel();
        this._renderEmptyState();

        this.eventBus?.emit(EVENTS.PANEL_CLEARED, { reason });
    }

    updateSection(sectionId, patch = {}) {
        if (!this.sectionInstances.has(sectionId)) {
            return;
        }
        const section = this.sectionInstances.get(sectionId);
        if (typeof section.update !== 'function') {
            return;
        }
        try {
            section.update(patch);
        } catch (err) {
            this.logger?.error?.('panel', 'Failed to update section', { sectionId, err });
        }
    }

    dispose() {
        this._disposeSections();
        this._clearPanel();
        this.container = null;
        super.dispose();
    }

    _renderEmptyState() {
        if (!this.container) {
            return;
        }
        this.container.innerHTML = '';
        const placeholder = document.createElement('div');
        placeholder.className = 'panel-placeholder panel-placeholder-rich';
        placeholder.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; height: 100%; padding: 40px;">
                <div style="text-align: center; color: #858585;">
                    <span class="material-symbols-outlined" style="font-size: 48px; opacity: 0.5; margin-bottom: 12px; display: block;">touch_app</span>
                    <h3 style="font-size: 16px; font-weight: 500; margin: 8px 0; color: #cccccc;">Select a Node</h3>
                    <p style="font-size: 13px; margin: 4px 0;">Click on a node in the workspace to configure its properties</p>
                </div>
            </div>
        `;
        this.container.appendChild(placeholder);
    }

    _createPanelShell(descriptor) {
        const shell = document.createElement('div');
        const shellClasses = ['node-config'];
        const descriptorClasses = [];
        if (descriptor?.className) {
            descriptorClasses.push(...String(descriptor.className).split(/\s+/).filter(Boolean));
        }
        if (descriptor?.variant) {
            descriptorClasses.push(`node-config--${descriptor.variant}`);
        }
        if (descriptor?.meta?.className) {
            descriptorClasses.push(...String(descriptor.meta.className).split(/\s+/).filter(Boolean));
        }
        shell.className = shellClasses.concat(descriptorClasses).join(' ');

        const stack = document.createElement('div');
        stack.className = 'config-stack';
        shell.appendChild(stack);
        return { shell, stack };
    }

    _renderSection(section, index) {
        const sectionId = section.id ?? `section-${index}`;
        const sectionEl = document.createElement('div');
        const classes = ['config-section'];
        if (section.fullWidth) {
            classes.push('config-section-full-width');
        } else {
            classes.push('config-section-wide');
        }
        if (section.className) {
            classes.push(...String(section.className).split(/\s+/).filter(Boolean));
        }
        if (section.variant) {
            classes.push(`config-section--${section.variant}`);
        }
        if (section.meta?.className) {
            classes.push(...String(section.meta.className).split(/\s+/).filter(Boolean));
        }
        if (section.meta?.variant) {
            classes.push(`config-section--${section.meta.variant}`);
        }
        sectionEl.className = classes.join(' ');

        if (section.title) {
            const titleEl = document.createElement('div');
            titleEl.className = 'config-section-header';
            titleEl.textContent = section.title;
            sectionEl.appendChild(titleEl);
        }

        // Handle custom section with componentKey
        if (section.custom && section.componentKey) {
            const customContent = this._renderCustomSection(section, sectionId);
            if (customContent) {
                sectionEl.appendChild(customContent);
            }
        } else {
            // Standard field-based section
            (section.fields ?? []).forEach((field, idx) => {
                const fieldEl = this._renderField(field, idx, sectionId);
                sectionEl.appendChild(fieldEl);
            });
        }

        if (section.actions?.length) {
            const actionBar = document.createElement('div');
            actionBar.className = 'panel-section__actions';
            section.actions.forEach((action) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'panel-section__action';
                button.textContent = action.label ?? 'Action';
                button.addEventListener('click', () => this._handleActionTriggered(sectionId, action));
                actionBar.appendChild(button);
            });
            sectionEl.appendChild(actionBar);
        }

        this.sectionInstances.set(sectionId, sectionEl);
        return sectionEl;
    }

    /**
     * Render a custom section using componentRegistry or built-in components.
     */
    _renderCustomSection(section, sectionId) {
        const componentKey = section.componentKey;
        const props = section.props ?? {};

        // Check componentRegistry first
        if (this.componentRegistry?.get) {
            const Component = this.componentRegistry.get(componentKey);
            if (Component) {
                const container = document.createElement('div');
                container.className = 'config-custom-section';
                try {
                    if (typeof Component === 'function') {
                        new Component(container, {
                            ...props,
                            nodeId: this.nodeId,
                            namespace: this.activeNamespace,
                            panel: this,
                        });
                    } else if (typeof Component.render === 'function') {
                        Component.render(container, {
                            ...props,
                            nodeId: this.nodeId,
                            namespace: this.activeNamespace,
                            panel: this,
                        });
                    }
                } catch (err) {
                    this.logger?.error?.('panel', 'Custom section render failed', { componentKey, err });
                }
                return container;
            }
        }

        // Built-in fallback components for common cases
        return this._renderBuiltInCustomSection(componentKey, props, sectionId);
    }

    /**
     * Built-in custom section implementations for plot axes, flow legs, etc.
     */
    _renderBuiltInCustomSection(componentKey, props, sectionId) {
        const container = document.createElement('div');
        container.className = 'config-custom-section';

        switch (componentKey) {
            case 'plot-x-axis-selector':
                this._renderPlotXAxisSelector(container, props);
                break;
            case 'plot-z-axis-editor':
                this._renderPlotZAxisEditor(container, props);
                break;
            case 'plot-y-axes-editor':
                this._renderPlotYAxesEditor(container, props);
                break;
            case 'flow-legs-editor':
                this._renderFlowLegsEditor(container, props);
                break;
            case 'signalDataSelectors':
                this._renderSignalDataSelectors(container, props);
                break;
            case 'signalPreviewChart':
                this._renderSignalPreviewChart(container, props);
                break;
            case 'signalAggregation':
                this._renderSignalAggregation(container, props);
                break;
            case 'generatorPreviewChart':
                this._renderGeneratorPreviewChart(container, props);
                break;
            case 'smoothFunctionPreviewChart':
                this._renderSmoothFunctionPreviewChart(container, props);
                break;
            default:
                container.innerHTML = `<div class="config-hint">Custom component "${componentKey}" not implemented</div>`;
                this.logger?.warn?.('panel', `Unknown custom component: ${componentKey}`);
                break;
        }

        return container;
    }

    /**
     * Render X axis selector for plot nodes.
     * X axis defaults to "time" (a virtual variable representing simulation time).
     * Uses autocomplete for variable selection (same as Y-axis series).
     */
    _renderPlotXAxisSelector(container, props) {
        // Check if simulation has been run
        const hasSimulationData = this.dataManager?.metadata?.lastSimulationDataset;
        if (!hasSimulationData) {
            const warning = document.createElement('div');
            warning.className = 'config-warning config-warning--solarized';

            const icon = document.createElement('span');
            icon.className = 'config-warning__icon material-symbols-outlined';
            icon.textContent = 'warning';

            const text = document.createElement('span');
            text.className = 'config-warning__text';
            text.textContent = 'Run simulation first to visualize data';

            warning.appendChild(icon);
            warning.appendChild(text);
            container.appendChild(warning);
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'config-row-vertical';

        // "Use time" checkbox
        const timeRow = document.createElement('div');
        timeRow.className = 'config-checkbox-row';

        const timeCheckbox = document.createElement('input');
        timeCheckbox.type = 'checkbox';
        timeCheckbox.id = `x-axis-time-${props.nodeId}`;
        // Check if using time: either refType is 'time', or there's no variable/stock selected
        const hasVariableOrStock = props.xAxisRef?.key || props.xAxisRef?.stockId;
        timeCheckbox.checked = props.xAxisRef?.refType === 'time' || !hasVariableOrStock;

        const timeLabel = document.createElement('label');
        timeLabel.htmlFor = timeCheckbox.id;
        timeLabel.textContent = 'Use simulation time';

        timeRow.appendChild(timeCheckbox);
        timeRow.appendChild(timeLabel);
        wrapper.appendChild(timeRow);

        // Variable selector container (hidden when using time)
        const variableContainer = document.createElement('div');
        variableContainer.className = 'x-axis-variable-container';
        variableContainer.style.display = timeCheckbox.checked ? 'none' : 'block';

        // Build namespace options for autocomplete
        const namespaceOptions = this.#buildNamespaceOptions({});

        // Resolve initial namespace from xAxisRef
        const initialNamespace = props.xAxisRef?.viewNamespace ?? props.xAxisRef?.namespaceId ?? this.activeNamespace ?? '__ALL__';
        const initialValue = props.xAxisRef?.refType !== 'time'
            ? (props.xAxisRef?.key || props.xAxisRef?.stockId || '')
            : '';

        // Create autocomplete field for variable search
        const fieldId = `x-axis-${props.nodeId}-${Date.now()}`;
        const autocomplete = new AutocompleteField({
            fieldId,
            field: {
                placeholder: 'Search variable...',
                value: initialValue,
                namespace: initialNamespace,
            },
            provider: (args) => this._getSeriesAutocompleteProvider(args),
            logger: this.logger,
            namespace: initialNamespace,
            namespaceOptions,
            showNamespaceSelect: true,
            skipNamespacePrefix: true,
            variant: 'legacy-variable',
            onChange: (value, options = {}) => {
                const selectedNamespace = options.namespace || autocomplete.selectedNamespace || this.activeNamespace;
                const viewNamespace = options.viewNamespace ?? options.namespace ?? autocomplete.selectedNamespace;

                // Detect if this is a stock variable (pattern: Sector::AccountType[Account])
                const isStock = value && value.includes('::') && value.includes('[') && value.includes(']');
                const refType = isStock ? 'stock' : 'variable';

                // When namespace is __ALL__, try to resolve the actual namespace from the variable key
                let resolvedNamespace = selectedNamespace !== '__ALL__' ? selectedNamespace : null;
                if (!resolvedNamespace && value && !isStock && this.dataManager) {
                    const allVars = this.dataManager.listVariables?.() || [];
                    const match = allVars.find((v) => v.key === value || v.name === value);
                    if (match?.namespaceId) {
                        resolvedNamespace = match.namespaceId;
                    }
                }

                const xAxisRef = isStock
                    ? { refType, stockId: value, label: value, viewNamespace }
                    : { refType, namespaceId: resolvedNamespace, viewNamespace, key: value || '' };
                this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                    nodeId: this.nodeId,
                    namespace: this.activeNamespace,
                    descriptorKey: 'xAxisRef',
                    value: xAxisRef,
                });
            },
        });

        // Store for cleanup
        if (!this.autocompleteFields) {
            this.autocompleteFields = new Map();
        }
        this.autocompleteFields.set(fieldId, autocomplete);

        variableContainer.appendChild(autocomplete.render());
        wrapper.appendChild(variableContainer);
        container.appendChild(wrapper);

        // Handle time checkbox change
        timeCheckbox.addEventListener('change', () => {
            variableContainer.style.display = timeCheckbox.checked ? 'none' : 'block';
            if (timeCheckbox.checked) {
                // Emit time reference
                this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                    nodeId: this.nodeId,
                    namespace: this.activeNamespace,
                    descriptorKey: 'xAxisRef',
                    value: { refType: 'time', key: 'time' },
                });
            }
        });
    }

    /**
     * Render Z axis editor for 3D plot nodes.
     * Shows "Add Z Axis" button when no z-axis is configured and exactly 1 y-axis exists.
     * When z-axis is configured, shows z-axis group with config fields and delete button.
     * Adding z-axis auto-selects 3D chart type.
     */
    _renderPlotZAxisEditor(container, props) {
        const config = props.zAxisConfig || {};
        const ref = config.ref || {};
        const yAxes = props.yAxes || [];
        const currentChartType = props.currentChartType || 'line';

        // Check if z-axis has a variable reference configured
        const hasZAxisRef = !!(ref.key || ref.stockId);

        // Z-axis can only be added/exist when exactly 1 y-axis is configured
        const canHaveZAxis = yAxes.length === 1;

        // Check if current chart type is 3D
        const is3DChartType = (type) => ['scatter3d', 'line3d', 'surface'].includes(type);

        // Helper to emit z-axis config update
        const emitConfigUpdate = (newConfig) => {
            this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                nodeId: this.nodeId,
                namespace: this.activeNamespace,
                descriptorKey: 'zAxisConfig',
                value: newConfig,
            });
        };

        // Helper to auto-select 3D chart type if not already 3D
        const autoSelect3DChartType = () => {
            if (!is3DChartType(currentChartType)) {
                this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                    nodeId: this.nodeId,
                    namespace: this.activeNamespace,
                    descriptorKey: 'chartType',
                    value: 'scatter3d',
                });
            }
        };

        // If no z-axis configured, show add button (only if exactly 1 y-axis)
        if (!hasZAxisRef) {
            if (!canHaveZAxis) {
                // Show hint that z-axis requires exactly 1 y-axis
                const hint = document.createElement('div');
                hint.className = 'config-hint';
                hint.textContent = yAxes.length === 0
                    ? 'Add a Y axis first to enable 3D plotting.'
                    : 'Remove extra Y axes to enable 3D plotting (requires exactly 1 Y axis).';
                container.appendChild(hint);
                return;
            }

            // Show "Add Z Axis" button
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'btn-add-axis';
            addBtn.innerHTML = '<span class="material-symbols-outlined">add</span> Add Z Axis';
            addBtn.addEventListener('click', () => {
                // Create new z-axis config with empty ref
                const newConfig = {
                    ref: { refType: 'variable', namespaceId: this.activeNamespace, key: '' },
                    label: null,
                    scale: 'linear',
                    min: null,
                    max: null,
                    step: null,
                };
                emitConfigUpdate(newConfig);
                autoSelect3DChartType();
            });
            container.appendChild(addBtn);
            return;
        }

        // Z-axis is configured - render the z-axis group
        const group = document.createElement('div');
        group.className = 'plot-axis-group';

        // Axis header
        const header = document.createElement('div');
        header.className = 'plot-axis-header';

        const axisLabel = document.createElement('span');
        axisLabel.className = 'axis-label';
        axisLabel.textContent = config.label || 'Z Axis';
        header.appendChild(axisLabel);

        // Helper to start editing axis label
        const startLabelEdit = () => {
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'axis-label-input';
            input.value = config.label || 'Z Axis';
            input.placeholder = 'Z Axis';

            const finishEdit = () => {
                const newLabel = input.value.trim();
                axisLabel.textContent = newLabel || 'Z Axis';
                input.replaceWith(axisLabel);
                emitConfigUpdate({ ...config, label: newLabel || null });
            };

            input.addEventListener('blur', finishEdit);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    input.blur();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    axisLabel.textContent = config.label || 'Z Axis';
                    input.replaceWith(axisLabel);
                }
            });

            axisLabel.replaceWith(input);
            input.focus();
            input.select();
        };

        // Double-click on label to edit
        axisLabel.addEventListener('dblclick', startLabelEdit);
        axisLabel.style.cursor = 'pointer';
        window.LatexTooltip?.set(axisLabel, 'Double-click to rename');

        const headerActions = document.createElement('div');
        headerActions.className = 'axis-header-actions';

        // Rename axis button
        const renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'btn-icon';
        renameBtn.innerHTML = '<span class="material-symbols-outlined">edit</span>';
        window.LatexTooltip?.set(renameBtn, 'Rename axis');
        renameBtn.addEventListener('click', startLabelEdit);
        headerActions.appendChild(renameBtn);

        // Remove z-axis button
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-icon btn-remove';
        removeBtn.innerHTML = '<span class="material-symbols-outlined">close</span>';
        window.LatexTooltip?.set(removeBtn, 'Remove Z axis');
        removeBtn.addEventListener('click', () => {
            // Clear z-axis config
            emitConfigUpdate(null);
        });
        headerActions.appendChild(removeBtn);

        header.appendChild(headerActions);
        group.appendChild(header);

        // Axis configuration row (matching y-axis style)
        const axisConfig = document.createElement('div');
        axisConfig.className = 'plot-axis-config';

        // Helper to create config field (same as y-axis)
        const createConfigField = (label, type, value, onChange, options = {}) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'axis-config-field';

            const labelEl = document.createElement('label');
            labelEl.textContent = label;
            wrapper.appendChild(labelEl);

            if (type === 'select' && options.choices) {
                const select = document.createElement('select');
                for (const opt of options.choices) {
                    const optEl = document.createElement('option');
                    optEl.value = opt.value;
                    optEl.textContent = opt.label;
                    if (opt.value === value) optEl.selected = true;
                    select.appendChild(optEl);
                }
                select.addEventListener('change', () => onChange(select.value));
                wrapper.appendChild(select);
            } else {
                const input = document.createElement('input');
                input.type = type;
                input.value = value ?? '';
                input.placeholder = options.placeholder || '';
                input.addEventListener('change', () => onChange(input.value));
                wrapper.appendChild(input);
            }

            return wrapper;
        };

        // Helper to update z-axis property
        const updateProp = (prop, value) => {
            emitConfigUpdate({ ...config, [prop]: value === '' ? null : value });
        };

        // Scale type selector
        axisConfig.appendChild(createConfigField('Scale', 'select', config.scale || 'linear',
            (val) => updateProp('scale', val), {
                choices: [
                    { value: 'linear', label: 'Linear' },
                    { value: 'log', label: 'Logarithmic' },
                ]
            }
        ));

        // Min value
        axisConfig.appendChild(createConfigField('Min', 'number', config.min,
            (val) => updateProp('min', val), { placeholder: 'Auto' }
        ));

        // Max value
        axisConfig.appendChild(createConfigField('Max', 'number', config.max,
            (val) => updateProp('max', val), { placeholder: 'Auto' }
        ));

        // Step value
        axisConfig.appendChild(createConfigField('Step', 'number', config.step,
            (val) => updateProp('step', val), { placeholder: 'Auto' }
        ));

        group.appendChild(axisConfig);

        // Variable selector (single series for z-axis)
        const seriesContainer = document.createElement('div');
        seriesContainer.className = 'plot-series-list';

        const seriesItem = document.createElement('div');
        seriesItem.className = 'plot-series-item plot-z-series-item';

        // Build namespace options for autocomplete
        const namespaceOptions = this.#buildNamespaceOptions({});

        // Resolve initial namespace from zAxisConfig.ref
        const initialNamespace = ref.viewNamespace ?? ref.namespaceId ?? this.activeNamespace ?? '__ALL__';
        const initialValue = ref.key || ref.stockId || '';

        // Create autocomplete field for variable search
        const fieldId = `z-axis-${props.nodeId}-${Date.now()}`;
        const autocomplete = new AutocompleteField({
            fieldId,
            field: {
                placeholder: 'Search variable for Z axis...',
                value: initialValue,
                namespace: initialNamespace,
            },
            provider: (args) => this._getSeriesAutocompleteProvider(args),
            logger: this.logger,
            namespace: initialNamespace,
            namespaceOptions,
            showNamespaceSelect: true,
            skipNamespacePrefix: true,
            variant: 'legacy-variable',
            onChange: (value, options = {}) => {
                const selectedNamespace = options.namespace || autocomplete.selectedNamespace || this.activeNamespace;
                const viewNamespace = options.viewNamespace ?? options.namespace ?? autocomplete.selectedNamespace;

                // Detect if this is a stock variable
                const isStock = value && value.includes('::') && value.includes('[') && value.includes(']');
                const refType = isStock ? 'stock' : 'variable';

                // Resolve namespace
                let resolvedNamespace = selectedNamespace !== '__ALL__' ? selectedNamespace : null;
                if (!resolvedNamespace && value && !isStock && this.dataManager) {
                    const allVars = this.dataManager.listVariables?.() || [];
                    const match = allVars.find((v) => v.key === value || v.name === value);
                    if (match?.namespaceId) {
                        resolvedNamespace = match.namespaceId;
                    }
                }

                const newRef = isStock
                    ? { refType, stockId: value, label: value, viewNamespace }
                    : { refType, namespaceId: resolvedNamespace, viewNamespace, key: value || '' };
                emitConfigUpdate({ ...config, ref: newRef });

                // Auto-select 3D chart type when z-axis variable is set
                if (value) {
                    autoSelect3DChartType();
                }
            },
        });

        // Store for cleanup
        if (!this.autocompleteFields) {
            this.autocompleteFields = new Map();
        }
        this.autocompleteFields.set(fieldId, autocomplete);

        const autocompleteEl = autocomplete.render();
        autocompleteEl.classList.add('series-autocomplete');
        seriesItem.appendChild(autocompleteEl);

        seriesContainer.appendChild(seriesItem);
        group.appendChild(seriesContainer);

        container.appendChild(group);
    }

    /**
     * Render Y axes editor for plot nodes.
     * Supports multiple Y axes, each with multiple series.
     * Uses AutocompleteField for variable search.
     * When z-axis is configured, adding new y-axes is disabled and y-axis cannot be deleted.
     */
    _renderPlotYAxesEditor(container, props) {
        const zAxisConfig = props.zAxisConfig || {};
        const zAxisRef = zAxisConfig.ref || {};
        const hasZAxis = !!(zAxisRef.key || zAxisRef.stockId);

        const axesList = document.createElement('div');
        axesList.className = 'plot-y-axes-list';

        const renderAxes = () => {
            axesList.innerHTML = '';
            const currentAxes = props.yAxes || [];

            if (currentAxes.length === 0) {
                const placeholder = document.createElement('div');
                placeholder.className = 'config-hint';
                placeholder.textContent = 'No Y axes configured. Click + to add an axis.';
                axesList.appendChild(placeholder);
            } else {
                currentAxes.forEach((axis, axisIdx) => {
                    const axisEl = this._renderYAxisGroup(axis, axisIdx, currentAxes, (updatedAxes) => {
                        props.yAxes = updatedAxes;
                        this._emitYAxesChange(updatedAxes);
                        renderAxes();
                    }, { hasZAxis });
                    axesList.appendChild(axisEl);
                });
            }
        };

        renderAxes();
        container.appendChild(axesList);

        // Add Y Axis button
        const addAxisBtn = document.createElement('button');
        addAxisBtn.type = 'button';
        addAxisBtn.className = 'btn-add-axis';
        addAxisBtn.innerHTML = '<span class="material-symbols-outlined">add</span> Add Y Axis';

        // Disable adding y-axis when z-axis is configured
        if (hasZAxis) {
            addAxisBtn.disabled = true;
            addAxisBtn.classList.add('btn-disabled');
            window.LatexTooltip?.set(addAxisBtn, 'Remove Z axis to add more Y axes');
        }

        addAxisBtn.addEventListener('click', () => {
            if (hasZAxis) return; // Prevent adding when z-axis exists
            const currentAxes = props.yAxes || [];
            const totalSeriesCount = currentAxes.reduce((sum, a) => sum + (a.series?.length || 0), 0);
            // Create new axis with a default empty series
            const newAxis = {
                id: `y-axis-${Date.now()}`,
                label: `Y Axis ${currentAxes.length + 1}`,
                series: [{
                    id: `series-${Date.now()}`,
                    ref: { refType: 'variable', namespaceId: this.activeNamespace, key: '' },
                    label: '',
                    color: this._getNextColor(totalSeriesCount),
                }],
            };
            props.yAxes = [...currentAxes, newAxis];
            this._emitYAxesChange(props.yAxes);
            renderAxes();
        });
        container.appendChild(addAxisBtn);
    }

    /**
     * Render a single Y axis group with its series.
     * @param {Object} options - Additional options
     * @param {boolean} options.hasZAxis - Whether z-axis is configured (disables remove)
     */
    _renderYAxisGroup(axis, axisIdx, allAxes, onUpdate, options = {}) {
        const { hasZAxis = false } = options;
        const group = document.createElement('div');
        group.className = 'plot-y-axis-group';

        // Axis header
        const header = document.createElement('div');
        header.className = 'plot-y-axis-header';

        const axisLabel = document.createElement('span');
        axisLabel.className = 'axis-label';
        axisLabel.textContent = axis.label || `Y Axis ${axisIdx + 1}`;
        header.appendChild(axisLabel);

        // Helper to start editing axis label
        const startLabelEdit = () => {
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'axis-label-input';
            input.value = axis.label || `Y Axis ${axisIdx + 1}`;
            input.placeholder = `Y Axis ${axisIdx + 1}`;

            const finishEdit = () => {
                const newLabel = input.value.trim();
                axisLabel.textContent = newLabel || `Y Axis ${axisIdx + 1}`;
                input.replaceWith(axisLabel);
                // Update axis label
                const updatedAxes = allAxes.map((a, i) => {
                    if (i !== axisIdx) return a;
                    return { ...a, label: newLabel || null };
                });
                onUpdate(updatedAxes);
            };

            input.addEventListener('blur', finishEdit);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    input.blur();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    axisLabel.textContent = axis.label || `Y Axis ${axisIdx + 1}`;
                    input.replaceWith(axisLabel);
                }
            });

            axisLabel.replaceWith(input);
            input.focus();
            input.select();
        };

        // Double-click on label to edit
        axisLabel.addEventListener('dblclick', startLabelEdit);
        axisLabel.style.cursor = 'pointer';
        window.LatexTooltip?.set(axisLabel, 'Double-click to rename');

        const headerActions = document.createElement('div');
        headerActions.className = 'axis-header-actions';

        // Rename axis button
        const renameAxisBtn = document.createElement('button');
        renameAxisBtn.type = 'button';
        renameAxisBtn.className = 'btn-icon';
        renameAxisBtn.innerHTML = '<span class="material-symbols-outlined">edit</span>';
        window.LatexTooltip?.set(renameAxisBtn, 'Rename axis');
        renameAxisBtn.addEventListener('click', startLabelEdit);
        headerActions.appendChild(renameAxisBtn);

        // Add series button
        const addSeriesBtn = document.createElement('button');
        addSeriesBtn.type = 'button';
        addSeriesBtn.className = 'btn-icon';
        addSeriesBtn.innerHTML = '<span class="material-symbols-outlined">add</span>';
        window.LatexTooltip?.set(addSeriesBtn, 'Add series to this axis');
        headerActions.appendChild(addSeriesBtn);

        // Remove axis button
        const removeAxisBtn = document.createElement('button');
        removeAxisBtn.type = 'button';
        removeAxisBtn.className = 'btn-icon btn-remove';
        removeAxisBtn.innerHTML = '<span class="material-symbols-outlined">close</span>';

        // Disable remove when z-axis is configured (must keep exactly 1 y-axis)
        if (hasZAxis) {
            removeAxisBtn.disabled = true;
            removeAxisBtn.classList.add('btn-disabled');
            window.LatexTooltip?.set(removeAxisBtn, 'Remove Z axis first to delete Y axis');
        } else {
            window.LatexTooltip?.set(removeAxisBtn, 'Remove axis');
        }
        headerActions.appendChild(removeAxisBtn);

        header.appendChild(headerActions);
        group.appendChild(header);

        // Axis configuration row
        const axisConfig = document.createElement('div');
        axisConfig.className = 'plot-axis-config';

        // Helper to create axis config field
        const createConfigField = (label, type, value, onChange, options = {}) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'axis-config-field';
            
            const labelEl = document.createElement('label');
            labelEl.textContent = label;
            wrapper.appendChild(labelEl);
            
            if (type === 'select' && options.choices) {
                const select = document.createElement('select');
                for (const opt of options.choices) {
                    const optEl = document.createElement('option');
                    optEl.value = opt.value;
                    optEl.textContent = opt.label;
                    if (opt.value === value) optEl.selected = true;
                    select.appendChild(optEl);
                }
                select.addEventListener('change', () => onChange(select.value));
                wrapper.appendChild(select);
            } else {
                const input = document.createElement('input');
                input.type = type;
                input.value = value ?? '';
                input.placeholder = options.placeholder || '';
                input.addEventListener('change', () => onChange(input.value));
                wrapper.appendChild(input);
            }
            
            return wrapper;
        };

        // Helper to update axis property
        const updateAxisProp = (prop, value) => {
            const updatedAxes = allAxes.map((a, i) => {
                if (i !== axisIdx) return a;
                return { ...a, [prop]: value === '' ? null : value };
            });
            onUpdate(updatedAxes);
        };

        // Scale type selector
        axisConfig.appendChild(createConfigField('Scale', 'select', axis.scale || 'linear', 
            (val) => updateAxisProp('scale', val), {
                choices: [
                    { value: 'linear', label: 'Linear' },
                    { value: 'log', label: 'Logarithmic' },
                ]
            }
        ));

        // Position selector
        axisConfig.appendChild(createConfigField('Position', 'select', axis.position || 'left',
            (val) => updateAxisProp('position', val), {
                choices: [
                    { value: 'left', label: 'Left' },
                    { value: 'right', label: 'Right' },
                ]
            }
        ));

        // Min value
        axisConfig.appendChild(createConfigField('Min', 'number', axis.min,
            (val) => updateAxisProp('min', val), { placeholder: 'Auto' }
        ));

        // Max value
        axisConfig.appendChild(createConfigField('Max', 'number', axis.max,
            (val) => updateAxisProp('max', val), { placeholder: 'Auto' }
        ));

        // Step value
        axisConfig.appendChild(createConfigField('Step', 'number', axis.step,
            (val) => updateAxisProp('step', val), { placeholder: 'Auto' }
        ));

        group.appendChild(axisConfig);

        // Series list
        const seriesList = document.createElement('div');
        seriesList.className = 'plot-series-list';

        const renderSeries = () => {
            seriesList.innerHTML = '';
            const currentSeries = axis.series || [];
            
            if (currentSeries.length === 0) {
                const hint = document.createElement('div');
                hint.className = 'config-hint';
                hint.textContent = 'No series. Click + to add.';
                seriesList.appendChild(hint);
            } else {
                currentSeries.forEach((series, seriesIdx) => {
                    const seriesEl = this._renderSeriesItem(series, seriesIdx, axisIdx, allAxes, (updatedAxes) => {
                        onUpdate(updatedAxes);
                    });
                    seriesList.appendChild(seriesEl);
                });
            }
        };

        renderSeries();
        group.appendChild(seriesList);

        // Add series handler
        addSeriesBtn.addEventListener('click', () => {
            const totalSeriesCount = allAxes.reduce((sum, a) => sum + (a.series?.length || 0), 0);
            const newSeries = {
                id: `series-${Date.now()}`,
                ref: { refType: 'variable', namespaceId: this.activeNamespace, key: '' },
                label: '',
                color: this._getNextColor(totalSeriesCount),
            };
            const updatedAxes = allAxes.map((a, i) => {
                if (i !== axisIdx) return a;
                return { ...a, series: [...(a.series || []), newSeries] };
            });
            onUpdate(updatedAxes);
            renderSeries();
        });

        // Remove axis handler
        removeAxisBtn.addEventListener('click', () => {
            if (hasZAxis) return; // Prevent removal when z-axis exists
            const updatedAxes = allAxes.filter((_, i) => i !== axisIdx);
            onUpdate(updatedAxes);
        });

        return group;
    }

    /**
     * Render a single series item with autocomplete for variable selection.
     */
    _renderSeriesItem(series, seriesIdx, axisIdx, allAxes, onUpdate) {
        const item = document.createElement('div');
        item.className = 'plot-series-item';

        // Build namespace options for autocomplete
        const namespaceOptions = this.#buildNamespaceOptions({});

        // Resolve initial namespace from series ref
        // Use viewNamespace if stored (preserves "All" selection), fall back to namespaceId, then activeNamespace
        const initialNamespace = series.ref?.viewNamespace ?? series.ref?.namespaceId ?? this.activeNamespace ?? '__ALL__';
        const initialValue = series.ref?.key || series.label || '';

        // Create autocomplete field for variable search
        const fieldId = `series-${axisIdx}-${seriesIdx}-${Date.now()}`;
        const autocomplete = new AutocompleteField({
            fieldId,
            field: {
                placeholder: 'Search variable...',
                value: initialValue,
                namespace: initialNamespace,
            },
            provider: (args) => this._getSeriesAutocompleteProvider(args),
            logger: this.logger,
            namespace: initialNamespace,
            namespaceOptions,
            showNamespaceSelect: true,
            skipNamespacePrefix: true,
            variant: 'legacy-variable', // Use magenta border styling
            onChange: (value, options = {}) => {
                const selectedNamespace = options.namespace || autocomplete.selectedNamespace || this.activeNamespace;
                const viewNamespace = options.viewNamespace ?? options.namespace ?? autocomplete.selectedNamespace;
                this._updateSeriesRef(axisIdx, seriesIdx, allAxes, value, selectedNamespace, viewNamespace, onUpdate);
            },
        });

        // Store for cleanup
        if (!this.autocompleteFields) {
            this.autocompleteFields = new Map();
        }
        this.autocompleteFields.set(fieldId, autocomplete);

        const autocompleteEl = autocomplete.render();
        autocompleteEl.classList.add('series-autocomplete');
        item.appendChild(autocompleteEl);

        // Label input (display name for legend)
        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'series-label';
        labelInput.placeholder = 'Legend label';
        labelInput.value = series.label || '';
        window.LatexTooltip?.set(labelInput, 'Legend display name');
        labelInput.addEventListener('change', () => {
            const updatedAxes = allAxes.map((a, aIdx) => {
                if (aIdx !== axisIdx) return a;
                return {
                    ...a,
                    series: (a.series || []).map((s, sIdx) => {
                        if (sIdx !== seriesIdx) return s;
                        return { ...s, label: labelInput.value };
                    }),
                };
            });
            onUpdate(updatedAxes);
        });
        item.appendChild(labelInput);

        // Color picker
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'series-color';
        colorInput.value = series.color || this._getNextColor(seriesIdx);
        window.LatexTooltip?.set(colorInput, 'Series color');
        colorInput.addEventListener('change', () => {
            const updatedAxes = allAxes.map((a, aIdx) => {
                if (aIdx !== axisIdx) return a;
                return {
                    ...a,
                    series: (a.series || []).map((s, sIdx) => {
                        if (sIdx !== seriesIdx) return s;
                        return { ...s, color: colorInput.value };
                    }),
                };
            });
            onUpdate(updatedAxes);
        });
        item.appendChild(colorInput);

        // Line width control
        const widthInput = document.createElement('input');
        widthInput.type = 'number';
        widthInput.className = 'series-width';
        widthInput.min = '1';
        widthInput.max = '10';
        widthInput.value = series.lineWidth ?? 2;
        window.LatexTooltip?.set(widthInput, 'Line width (1-10)');
        widthInput.addEventListener('change', () => {
            const width = Math.max(1, Math.min(10, Number(widthInput.value) || 2));
            widthInput.value = width;
            const updatedAxes = allAxes.map((a, aIdx) => {
                if (aIdx !== axisIdx) return a;
                return {
                    ...a,
                    series: (a.series || []).map((s, sIdx) => {
                        if (sIdx !== seriesIdx) return s;
                        return { ...s, lineWidth: width };
                    }),
                };
            });
            onUpdate(updatedAxes);
        });
        item.appendChild(widthInput);

        // Line style dropdown (solid, dashed, dotted)
        const styleSelect = document.createElement('select');
        styleSelect.className = 'series-style';
        window.LatexTooltip?.set(styleSelect, 'Line style');
        [
            { value: 'solid', label: 'Solid' },
            { value: 'dashed', label: 'Dashed' },
            { value: 'dotted', label: 'Dotted' },
        ].forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            if ((series.lineStyle || 'solid') === opt.value) {
                option.selected = true;
            }
            styleSelect.appendChild(option);
        });
        styleSelect.addEventListener('change', () => {
            const updatedAxes = allAxes.map((a, aIdx) => {
                if (aIdx !== axisIdx) return a;
                return {
                    ...a,
                    series: (a.series || []).map((s, sIdx) => {
                        if (sIdx !== seriesIdx) return s;
                        return { ...s, lineStyle: styleSelect.value };
                    }),
                };
            });
            onUpdate(updatedAxes);
        });
        item.appendChild(styleSelect);

        // Stack group input (series with same group name stack as filled areas)
        const stackInput = document.createElement('input');
        stackInput.type = 'text';
        stackInput.className = 'series-stack-group';
        stackInput.placeholder = 'Stack';
        stackInput.value = series.stackGroup || '';
        window.LatexTooltip?.set(stackInput, 'Stack group name — series with the same name stack as filled areas');
        stackInput.addEventListener('change', () => {
            const updatedAxes = allAxes.map((a, aIdx) => {
                if (aIdx !== axisIdx) return a;
                return {
                    ...a,
                    series: (a.series || []).map((s, sIdx) => {
                        if (sIdx !== seriesIdx) return s;
                        return { ...s, stackGroup: stackInput.value.trim() || null };
                    }),
                };
            });
            onUpdate(updatedAxes);
        });
        item.appendChild(stackInput);

        // Remove series button
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-icon btn-remove';
        removeBtn.innerHTML = '<span class="material-symbols-outlined">close</span>';
        window.LatexTooltip?.set(removeBtn, 'Remove series');
        removeBtn.addEventListener('click', () => {
            const updatedAxes = allAxes.map((a, aIdx) => {
                if (aIdx !== axisIdx) return a;
                return {
                    ...a,
                    series: (a.series || []).filter((_, sIdx) => sIdx !== seriesIdx),
                };
            });
            onUpdate(updatedAxes);
        });
        item.appendChild(removeBtn);

        return item;
    }

    /**
     * Autocomplete provider for series variable search.
     */
    _getSeriesAutocompleteProvider({ value, namespace, scope }) {
        if (!this.expressionServices) {
            return [];
        }
        try {
            const targetNamespace = namespace && namespace !== '__ALL__' ? namespace : null;
            const includeCrossNamespace = scope === 'all' || namespace === '__ALL__' || !targetNamespace;

            const entries = this.expressionServices.buildAutocompleteEntries({
                namespaceId: targetNamespace,
                includeCrossNamespace,
                includeDisplayNames: false,
                includeStocks: true,
                includeOperators: false,
                includeSnippets: false,
                includeConstants: false,
            }) || [];

            // Filter by namespace when not showing all
            const filtered = includeCrossNamespace
                ? entries
                : entries.filter((e) => (e?.metadata?.namespaceId ?? null) === targetNamespace);

            // Sort alphabetically
            const sorted = filtered.slice().sort((a, b) => {
                const aLabel = (a?.label || '').toLowerCase();
                const bLabel = (b?.label || '').toLowerCase();
                return aLabel.localeCompare(bLabel);
            });

            // Filter by search text
            const fragment = (value || '').toLowerCase().trim();
            if (!fragment) {
                return sorted;
            }
            return sorted.filter((e) => (e.label || '').toLowerCase().includes(fragment));
        } catch (err) {
            this.logger?.warn?.('panel', 'Series autocomplete error', { err });
            return [];
        }
    }

    /**
     * Update series ref when variable is selected.
     * Detects stock variables by the Sector::AccountType[Account] pattern.
     * @param {string} viewNamespace - The namespace selection in the dropdown (could be __ALL__)
     */
    _updateSeriesRef(axisIdx, seriesIdx, allAxes, value, namespace, viewNamespace, onUpdate) {
        // Detect if this is a stock variable (pattern: Sector::AccountType[Account])
        const isStock = value && value.includes('::') && value.includes('[') && value.includes(']');
        const refType = isStock ? 'stock' : 'variable';

        // When namespace is __ALL__, try to resolve the actual namespace from the variable key
        // Prioritize the plot node's active namespace to avoid picking wrong namespace match
        let resolvedNamespace = namespace === '__ALL__' ? null : namespace;
        if (!resolvedNamespace && value && !isStock && this.dataManager) {
            // Search all namespaces for this variable key
            const allVars = this.dataManager.listVariables?.() || [];
            const matches = allVars.filter((v) => v.key === value || v.name === value);
            if (matches.length > 0) {
                // Prioritize the plot node's active namespace
                const localMatch = this.activeNamespace
                    ? matches.find((v) => v.namespaceId === this.activeNamespace)
                    : null;
                resolvedNamespace = localMatch?.namespaceId ?? matches[0]?.namespaceId ?? null;
            }
        }
        
        const updatedAxes = allAxes.map((a, aIdx) => {
            if (aIdx !== axisIdx) return a;
            return {
                ...a,
                series: (a.series || []).map((s, sIdx) => {
                    if (sIdx !== seriesIdx) return s;
                    const ref = isStock
                        ? { refType, stockId: value, label: value, viewNamespace }
                        : { refType, namespaceId: resolvedNamespace, key: value, viewNamespace };
                    return { ...s, label: value, ref };
                }),
            };
        });
        onUpdate(updatedAxes);
    }

    _emitYAxesChange(yAxes) {
        // Deep clone to ensure event receives immutable snapshot
        const clonedYAxes = JSON.parse(JSON.stringify(yAxes));
        this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
            nodeId: this.nodeId,
            namespace: this.activeNamespace,
            descriptorKey: 'yAxes',
            value: clonedYAxes,
            immediate: false,
        });
    }

    _getNextColor(index) {
        // Solarized theme colors matching legacy plot_node.js
        const colors = [
            '#268bd2', // 1st: Solarized Blue (flow node)
            '#d33682', // 2nd: Solarized Magenta (variable node)
            '#cb4b16', // 3rd: Solarized Orange (function node)
            '#2aa198', // 4th: Solarized Cyan (constant node)
            '#6a5acd', // 5th: SlateBlue/Purple (operation node)
            '#7a7d80', // 6th: Gray (parameter node)
            '#9fb6cf', // 7th+: Gray-Blue (stock variable node)
        ];
        // For index 0-5, use specific colors; for 6+, use the last color
        if (index < 6) {
            return colors[index];
        }
        return colors[6];
    }

    /**
     * Render flow legs editor (placeholder - actual implementation in godley components).
     */
    _renderFlowLegsEditor(container, props) {
        // This is typically handled by the GodleyTable component
        // For now, show a placeholder
        container.innerHTML = `
            <div class="config-hint">
                Stock entries are configured in the Godley panel below.
            </div>
        `;
    }

    /**
     * Render signal data selectors (dataset, series, time column, value column).
     */
    _renderSignalDataSelectors(container, props) {
        container.className = 'signal-data-selectors';

        // Dataset row
        const dsRow = document.createElement('div');
        dsRow.className = 'config-row';

        const dsLabel = document.createElement('label');
        dsLabel.className = 'config-label';
        dsLabel.textContent = 'Dataset';

        const dsSelect = document.createElement('select');
        dsSelect.className = 'config-input signal-dataset-select';
        dsSelect.innerHTML = '<option value="">Loading...</option>';

        dsRow.appendChild(dsLabel);
        dsRow.appendChild(dsSelect);
        container.appendChild(dsRow);

        // Series row
        const seriesRow = document.createElement('div');
        seriesRow.className = 'config-row';

        const seriesLabel = document.createElement('label');
        seriesLabel.className = 'config-label';
        seriesLabel.textContent = 'Series';

        const seriesSelect = document.createElement('select');
        seriesSelect.className = 'config-input signal-series-select';
        seriesSelect.innerHTML = '<option value="">Select dataset first...</option>';
        seriesSelect.disabled = true;

        seriesRow.appendChild(seriesLabel);
        seriesRow.appendChild(seriesSelect);
        container.appendChild(seriesRow);

        // Time column row
        const timeRow = document.createElement('div');
        timeRow.className = 'config-row';

        const timeLabel = document.createElement('label');
        timeLabel.className = 'config-label';
        timeLabel.textContent = 'Time Column';

        const timeSelect = document.createElement('select');
        timeSelect.className = 'config-input signal-time-column-select';
        timeSelect.innerHTML = '<option value="">Select series first...</option>';
        timeSelect.disabled = true;

        timeRow.appendChild(timeLabel);
        timeRow.appendChild(timeSelect);
        container.appendChild(timeRow);

        // Value column row
        const valueRow = document.createElement('div');
        valueRow.className = 'config-row';

        const valueLabel = document.createElement('label');
        valueLabel.className = 'config-label';
        valueLabel.textContent = 'Value Column';

        const valueSelect = document.createElement('select');
        valueSelect.className = 'config-input signal-value-column-select';
        valueSelect.innerHTML = '<option value="">Select series first...</option>';
        valueSelect.disabled = true;

        valueRow.appendChild(valueLabel);
        valueRow.appendChild(valueSelect);
        container.appendChild(valueRow);

        // Async population
        this._populateSignalDataSelectors(dsSelect, seriesSelect, timeSelect, valueSelect, props);

        // Event handlers
        dsSelect.addEventListener('change', () => {
            const datasetId = dsSelect.value;
            const datasetName = dsSelect.options[dsSelect.selectedIndex]?.textContent || '';

            this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                nodeId: this.nodeId,
                namespace: this.activeNamespace,
                descriptorKey: 'datasetId',
                value: datasetId,
            });
            this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                nodeId: this.nodeId,
                namespace: this.activeNamespace,
                descriptorKey: 'datasetName',
                value: datasetName,
            });

            // Clear series and column selections
            seriesSelect.innerHTML = '<option value="">Loading series...</option>';
            seriesSelect.disabled = true;
            timeSelect.innerHTML = '<option value="">Select series first...</option>';
            valueSelect.innerHTML = '<option value="">Select series first...</option>';
            timeSelect.disabled = true;
            valueSelect.disabled = true;

            // Clear stored series/column values
            this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                nodeId: this.nodeId,
                namespace: this.activeNamespace,
                descriptorKey: 'seriesId',
                value: '',
            });
            this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                nodeId: this.nodeId,
                namespace: this.activeNamespace,
                descriptorKey: 'seriesName',
                value: '',
            });

            // Populate series for new dataset, then refresh preview
            this._populateSignalSeries(datasetId, seriesSelect, timeSelect, valueSelect).then(() => {
                this._refreshSignalPreview(datasetId, seriesSelect.value, timeSelect.value, valueSelect.value);
            });
        });

        seriesSelect.addEventListener('change', () => {
            const seriesId = seriesSelect.value;
            const seriesName = seriesSelect.options[seriesSelect.selectedIndex]?.textContent || '';

            this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                nodeId: this.nodeId,
                namespace: this.activeNamespace,
                descriptorKey: 'seriesId',
                value: seriesId,
            });
            this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                nodeId: this.nodeId,
                namespace: this.activeNamespace,
                descriptorKey: 'seriesName',
                value: seriesName,
            });

            // Clear column selections
            timeSelect.innerHTML = '<option value="">Loading columns...</option>';
            valueSelect.innerHTML = '<option value="">Loading columns...</option>';
            timeSelect.disabled = true;
            valueSelect.disabled = true;

            // Populate columns for new series, then refresh preview
            this._populateSignalColumns(seriesId, timeSelect, valueSelect).then(() => {
                this._refreshSignalPreview(dsSelect.value, seriesId, timeSelect.value, valueSelect.value);
            });
        });

        timeSelect.addEventListener('change', () => {
            this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                nodeId: this.nodeId,
                namespace: this.activeNamespace,
                descriptorKey: 'timeColumn',
                value: timeSelect.value,
            });
            // Refresh preview with new column selection
            this._refreshSignalPreview(dsSelect.value, seriesSelect.value, timeSelect.value, valueSelect.value);
        });

        valueSelect.addEventListener('change', () => {
            this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                nodeId: this.nodeId,
                namespace: this.activeNamespace,
                descriptorKey: 'valueColumn',
                value: valueSelect.value,
            });
            // Refresh preview with new column selection
            this._refreshSignalPreview(dsSelect.value, seriesSelect.value, timeSelect.value, valueSelect.value);
        });
    }

    /**
     * Refresh the signal preview chart with new data source.
     * When called without arguments, reads current selections from the DOM.
     */
    _refreshSignalPreview(datasetId, seriesId, timeColumn, valueColumn) {
        // Find the preview container in the panel
        const previewContainer = this.container?.querySelector('.signal-preview-container');
        if (!previewContainer) return;

        const canvas = previewContainer.querySelector('.signal-preview-canvas');
        const hint = previewContainer.querySelector('.signal-preview-hint');
        if (!canvas || !hint) return;

        // When called without args (e.g., from aggregation controls), read from DOM
        if (datasetId === undefined) {
            const dsSelect = this.container?.querySelector('.signal-dataset-select');
            const seriesSelect = this.container?.querySelector('.signal-series-select');
            const timeSelect = this.container?.querySelector('.signal-time-column-select');
            const valueSelect = this.container?.querySelector('.signal-value-column-select');
            datasetId = dsSelect?.value || '';
            seriesId = seriesSelect?.value || '';
            timeColumn = timeSelect?.value || '';
            valueColumn = valueSelect?.value || '';
        }

        // Read aggregation state from DOM
        const groupBySelect = this.container?.querySelector('.signal-group-by-select');
        const aggFnSelect = this.container?.querySelector('.signal-agg-function-select');
        const groupByColumn = groupBySelect?.value || '';
        const aggregationFunction = aggFnSelect?.value || 'sum';

        // Build group filter from checklist
        let groupFilter = '';
        const checklist = this.container?.querySelector('.signal-group-filter-checklist');
        if (checklist && groupByColumn) {
            const allCbs = checklist.querySelectorAll('input[type="checkbox"]');
            const checkedCbs = checklist.querySelectorAll('input[type="checkbox"]:checked');
            // All checked = no filter
            if (checkedCbs.length < allCbs.length) {
                groupFilter = Array.from(checkedCbs).map((cb) => cb.value).join(',');
            }
        }

        // Re-render with new data
        this._renderSignalPreviewData(canvas, hint, {
            datasetId,
            seriesId,
            timeColumn,
            valueColumn,
            groupByColumn,
            aggregationFunction,
            groupFilter,
        });
    }

    /**
     * Populate signal data selectors from API.
     * Filters out the "Scenarios" dataset since signal sources are for external data.
     */
    async _populateSignalDataSelectors(dsSelect, seriesSelect, timeSelect, valueSelect, props, _retry = false) {
        try {
            const api = window.pywebview?.api;
            if (!api?.list_repo) {
                dsSelect.innerHTML = '<option value="">API not available</option>';
                return;
            }

            const result = await apiCallWithTimeout(() => api.list_repo());
            let datasets = result?.ok && Array.isArray(result.datasets) ? result.datasets : [];

            // Filter out "Scenarios" dataset - signal sources are for external data only
            datasets = datasets.filter((ds) => {
                const name = (ds.name || '').toLowerCase();
                return name !== 'scenarios';
            });

            dsSelect.innerHTML = '<option value="">Select dataset...</option>';
            datasets.forEach((ds) => {
                const opt = document.createElement('option');
                opt.value = ds.id;
                opt.textContent = ds.name || ds.id;
                dsSelect.appendChild(opt);
            });

            // Match dataset from the dropdown list. list_repo deduplicates by name so the
            // ID from auto-resolve (which may come from a different workspace's copy) might
            // not appear in the list. Always verify the ID is present; fall back to name match.
            let matched = datasets.find(ds => ds.id === props.datasetId);
            if (!matched && props.datasetName) {
                matched = datasets.find(ds => ds.name === props.datasetName);
            }
            if (matched) {
                dsSelect.value = matched.id;
                // Sync snapshot when name-based fallback resolved a different ID
                if (matched.id !== props.datasetId) {
                    this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                        nodeId: this.nodeId,
                        namespace: this.activeNamespace,
                        descriptorKey: 'datasetId',
                        value: matched.id,
                    });
                }
                await this._populateSignalSeries(
                    matched.id, seriesSelect, timeSelect, valueSelect, props, datasets,
                );
            }

            // Refresh preview with the resolved dropdown values (the initial preview
            // render may have used stale/empty IDs from the snapshot).
            this._refreshSignalPreview(
                dsSelect.value, seriesSelect.value, timeSelect.value, valueSelect.value,
            );
        } catch (err) {
            // Retry once on timeout (pywebview stale callback from page re-injection)
            if (!_retry && err?.message === 'api_timeout') {
                this.logger?.debug?.('panel', 'Signal dataset population timed out, retrying...');
                return this._populateSignalDataSelectors(dsSelect, seriesSelect, timeSelect, valueSelect, props, true);
            }
            this.logger?.warn?.('panel', 'Failed to populate signal datasets', { err });
            dsSelect.innerHTML = '<option value="">Failed to load</option>';
        }
    }

    /**
     * Populate series selector for a dataset.
     * @param {Array} [cachedDatasets] - Pre-fetched datasets list to avoid redundant list_repo call
     */
    async _populateSignalSeries(datasetId, seriesSelect, timeSelect, valueSelect, props = {}, cachedDatasets = null) {
        if (!datasetId) {
            seriesSelect.innerHTML = '<option value="">Select dataset first...</option>';
            seriesSelect.disabled = true;
            return;
        }

        try {
            let datasets = cachedDatasets;
            if (!datasets) {
                const api = window.pywebview?.api;
                if (!api?.list_repo) {
                    seriesSelect.innerHTML = '<option value="">API not available</option>';
                    return;
                }
                const result = await apiCallWithTimeout(() => api.list_repo());
                datasets = result?.ok && Array.isArray(result.datasets) ? result.datasets : [];
            }
            const dataset = datasets.find((ds) => ds.id === datasetId);
            const seriesList = Array.isArray(dataset?.series) ? dataset.series : [];

            seriesSelect.innerHTML = '<option value="">Select series...</option>';
            seriesList.forEach((s) => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.textContent = s.name || s.id;
                seriesSelect.appendChild(opt);
            });
            seriesSelect.disabled = false;

            // Match series from the dropdown list. The stored seriesId may reference a
            // different workspace's copy (list_repo deduplicates datasets by name, so the
            // series IDs change). Prefer matching by ID, then modelVariable, then seriesName.
            let matched = seriesList.find(s => s.id === props.seriesId);
            if (!matched && props.modelVariable) {
                const pattern = `(${props.modelVariable})`;
                matched = seriesList.find(s => (s.name || '').includes(pattern));
            }
            if (!matched && props.seriesName) {
                matched = seriesList.find(s => (s.name || '') === props.seriesName);
            }
            if (matched) {
                seriesSelect.value = matched.id;
                // Sync snapshot when name/pattern-based fallback resolved a different ID
                if (matched.id !== props.seriesId) {
                    this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                        nodeId: this.nodeId,
                        namespace: this.activeNamespace,
                        descriptorKey: 'seriesId',
                        value: matched.id,
                    });
                    this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                        nodeId: this.nodeId,
                        namespace: this.activeNamespace,
                        descriptorKey: 'seriesName',
                        value: matched.name || '',
                    });
                }
                await this._populateSignalColumns(matched.id, timeSelect, valueSelect, props);
            }
        } catch (err) {
            this.logger?.warn?.('panel', 'Failed to populate signal series', { err });
            seriesSelect.innerHTML = '<option value="">Failed to load</option>';
        }
    }

    /**
     * Populate column selectors for a series.
     */
    async _populateSignalColumns(seriesId, timeSelect, valueSelect, props = {}) {
        if (!seriesId) {
            timeSelect.innerHTML = '<option value="">Select series first...</option>';
            valueSelect.innerHTML = '<option value="">Select series first...</option>';
            timeSelect.disabled = true;
            valueSelect.disabled = true;
            return;
        }

        try {
            const api = window.pywebview?.api;
            if (!api?.get_series_headers) {
                timeSelect.innerHTML = '<option value="">API not available</option>';
                valueSelect.innerHTML = '<option value="">API not available</option>';
                return;
            }

            // Fast path: fetch only column headers (no data loading)
            const result = await apiCallWithTimeout(() => api.get_series_headers(seriesId));
            const headers = result?.ok && Array.isArray(result.headers) ? result.headers : [];

            // Cache headers for sibling components (e.g. signalAggregation)
            this._signalHeadersCache = { seriesId, headers };

            // Populate time column — always include tDisp (stored separately from data columns)
            timeSelect.innerHTML = '<option value="">Select time column...</option>';
            const tDispOpt = document.createElement('option');
            tDispOpt.value = 'tDisp';
            tDispOpt.textContent = 'tDisp (time index)';
            timeSelect.appendChild(tDispOpt);
            headers.forEach((col) => {
                const opt = document.createElement('option');
                opt.value = col;
                opt.textContent = col;
                timeSelect.appendChild(opt);
            });
            timeSelect.disabled = false;

            // Populate value column (same options)
            valueSelect.innerHTML = '<option value="">Select value column...</option>';
            headers.forEach((col) => {
                const opt = document.createElement('option');
                opt.value = col;
                opt.textContent = col;
                valueSelect.appendChild(opt);
            });
            valueSelect.disabled = false;

            // Restore selections if provided
            if (props.timeColumn) {
                timeSelect.value = props.timeColumn;
            }
            if (props.valueColumn) {
                valueSelect.value = props.valueColumn;
            }
        } catch (err) {
            this.logger?.warn?.('panel', 'Failed to populate signal columns', { err });
            timeSelect.innerHTML = '<option value="">Failed to load</option>';
            valueSelect.innerHTML = '<option value="">Failed to load</option>';
        }
    }

    /**
     * Render signal aggregation controls (group by, function, filter).
     */
    _renderSignalAggregation(container, props) {
        container.className = 'signal-aggregation-selectors';

        // Group By row
        const groupRow = document.createElement('div');
        groupRow.className = 'config-row';

        const groupLabel = document.createElement('label');
        groupLabel.className = 'config-label';
        groupLabel.textContent = 'Group By';

        const groupSelect = document.createElement('select');
        groupSelect.className = 'config-input signal-group-by-select';
        groupSelect.innerHTML = '<option value="">None (no grouping)</option>';

        groupRow.appendChild(groupLabel);
        groupRow.appendChild(groupSelect);
        container.appendChild(groupRow);

        // Aggregation Function row
        const fnRow = document.createElement('div');
        fnRow.className = 'config-row';

        const fnLabel = document.createElement('label');
        fnLabel.className = 'config-label';
        fnLabel.textContent = 'Function';

        const fnSelect = document.createElement('select');
        fnSelect.className = 'config-input signal-agg-function-select';
        const aggOptions = [
            { value: 'sum', label: 'Sum' },
            { value: 'mean', label: 'Mean' },
            { value: 'min', label: 'Min' },
            { value: 'max', label: 'Max' },
            { value: 'median', label: 'Median' },
            { value: 'count', label: 'Count' },
        ];
        aggOptions.forEach((opt) => {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            fnSelect.appendChild(el);
        });
        fnSelect.value = props.aggregationFunction || 'sum';
        fnSelect.disabled = !props.groupByColumn;

        fnRow.appendChild(fnLabel);
        fnRow.appendChild(fnSelect);
        container.appendChild(fnRow);

        // Filter row
        const filterRow = document.createElement('div');
        filterRow.className = 'config-row config-row--vertical';

        const filterLabel = document.createElement('label');
        filterLabel.className = 'config-label';
        filterLabel.textContent = 'Filter';

        const filterContainer = document.createElement('div');
        filterContainer.className = 'signal-group-filter';
        filterContainer.innerHTML = '<span class="config-hint">Select a group column first</span>';

        filterRow.appendChild(filterLabel);
        filterRow.appendChild(filterContainer);
        container.appendChild(filterRow);

        // Populate group-by column dropdown from series headers
        this._populateSignalGroupByColumn(groupSelect, fnSelect, filterContainer, props);

        // Event handlers
        groupSelect.addEventListener('change', () => {
            const groupByColumn = groupSelect.value;

            this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                nodeId: this.nodeId,
                namespace: this.activeNamespace,
                descriptorKey: 'groupByColumn',
                value: groupByColumn,
            });

            fnSelect.disabled = !groupByColumn;

            if (!groupByColumn) {
                // Clear filter and emit empty values
                filterContainer.innerHTML = '<span class="config-hint">Select a group column first</span>';
                this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                    nodeId: this.nodeId,
                    namespace: this.activeNamespace,
                    descriptorKey: 'groupFilter',
                    value: '',
                });
            } else {
                // Populate filter with unique values
                this._populateSignalGroupFilter(props.seriesId, groupByColumn, filterContainer, props.groupFilter || '');
            }

            // Refresh preview
            this._refreshSignalPreview();
        });

        fnSelect.addEventListener('change', () => {
            this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                nodeId: this.nodeId,
                namespace: this.activeNamespace,
                descriptorKey: 'aggregationFunction',
                value: fnSelect.value,
            });
            this._refreshSignalPreview();
        });
    }

    /**
     * Populate group-by column dropdown from series headers.
     * Excludes the currently selected time and value columns.
     */
    async _populateSignalGroupByColumn(groupSelect, fnSelect, filterContainer, props) {
        const seriesId = props.seriesId;
        if (!seriesId) return;

        try {
            // Use cached headers from _populateSignalColumns if available
            let headers;
            if (this._signalHeadersCache?.seriesId === seriesId) {
                headers = this._signalHeadersCache.headers;
            } else {
                const api = window.pywebview?.api;
                if (!api?.get_series_headers) return;
                const result = await apiCallWithTimeout(() => api.get_series_headers(seriesId));
                headers = result?.ok && Array.isArray(result.headers) ? result.headers : [];
            }

            // Exclude time and value columns from group-by options
            const excluded = new Set();
            if (props.timeColumn) excluded.add(props.timeColumn);
            if (props.valueColumn) excluded.add(props.valueColumn);

            const candidates = headers.filter((h) => !excluded.has(h));

            // Rebuild dropdown preserving the "None" option
            groupSelect.innerHTML = '<option value="">None (no grouping)</option>';
            candidates.forEach((col) => {
                const opt = document.createElement('option');
                opt.value = col;
                opt.textContent = col;
                groupSelect.appendChild(opt);
            });

            // Restore selection
            if (props.groupByColumn) {
                groupSelect.value = props.groupByColumn;
                fnSelect.disabled = !props.groupByColumn;

                if (props.groupByColumn) {
                    this._populateSignalGroupFilter(
                        seriesId, props.groupByColumn, filterContainer, props.groupFilter || '',
                    );
                }
            }
        } catch (err) {
            this.logger?.warn?.('panel', 'Failed to populate group-by columns', { err });
        }
    }

    /**
     * Populate the filter checklist with unique values from the group-by column.
     */
    async _populateSignalGroupFilter(seriesId, columnName, filterContainer, currentFilter) {
        if (!seriesId || !columnName) {
            filterContainer.innerHTML = '<span class="config-hint">Select a group column first</span>';
            return;
        }

        filterContainer.innerHTML = '<span class="config-hint">Loading...</span>';

        try {
            const api = window.pywebview?.api;
            if (!api?.get_column_unique_values) {
                filterContainer.innerHTML = '<span class="config-hint">API not available</span>';
                return;
            }

            const result = await apiCallWithTimeout(() => api.get_column_unique_values({
                series_id: seriesId,
                column_name: columnName,
            }));

            if (!result?.ok || !Array.isArray(result.values)) {
                filterContainer.innerHTML = '<span class="config-hint">No values found</span>';
                return;
            }

            const values = result.values;
            if (values.length === 0) {
                filterContainer.innerHTML = '<span class="config-hint">No values found</span>';
                return;
            }

            // Parse current filter into a set
            const activeFilters = new Set();
            if (currentFilter) {
                currentFilter.split(',').forEach((v) => {
                    const trimmed = v.trim();
                    if (trimmed) activeFilters.add(trimmed);
                });
            }
            // If no active filter, treat as "all included" (no checkboxes checked = all)
            const hasActiveFilter = activeFilters.size > 0;

            filterContainer.innerHTML = '';

            // Scrollable checklist wrapper
            const checklist = document.createElement('div');
            checklist.className = 'signal-group-filter-checklist';

            values.forEach((val) => {
                const item = document.createElement('label');
                item.className = 'signal-group-filter-item';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = val;
                cb.checked = hasActiveFilter ? activeFilters.has(val) : true;

                const span = document.createElement('span');
                span.textContent = val;

                item.appendChild(cb);
                item.appendChild(span);
                checklist.appendChild(item);

                cb.addEventListener('change', () => {
                    this._emitGroupFilterFromChecklist(checklist, values.length);
                    this._refreshSignalPreview();
                });
            });

            filterContainer.appendChild(checklist);

            // Select All / Deselect All controls
            if (values.length > 3) {
                const controls = document.createElement('div');
                controls.className = 'signal-group-filter-controls';

                const selectAll = document.createElement('a');
                selectAll.href = '#';
                selectAll.textContent = 'All';
                selectAll.addEventListener('click', (e) => {
                    e.preventDefault();
                    checklist.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
                    this._emitGroupFilterFromChecklist(checklist, values.length);
                    this._refreshSignalPreview();
                });

                const separator = document.createTextNode(' / ');

                const deselectAll = document.createElement('a');
                deselectAll.href = '#';
                deselectAll.textContent = 'None';
                deselectAll.addEventListener('click', (e) => {
                    e.preventDefault();
                    checklist.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
                    this._emitGroupFilterFromChecklist(checklist, values.length);
                    this._refreshSignalPreview();
                });

                controls.appendChild(selectAll);
                controls.appendChild(separator);
                controls.appendChild(deselectAll);
                filterContainer.appendChild(controls);
            }
        } catch (err) {
            this.logger?.warn?.('panel', 'Failed to populate group filter', { err });
            filterContainer.innerHTML = '<span class="config-hint">Failed to load values</span>';
        }
    }

    /**
     * Emit groupFilter value from the checklist state.
     * If all checkboxes are checked, emit empty string (= include all).
     */
    _emitGroupFilterFromChecklist(checklist, totalCount) {
        const checked = Array.from(checklist.querySelectorAll('input[type="checkbox"]:checked'));
        // All checked = no filter (include all)
        const filterValue = checked.length === totalCount ? '' : checked.map((cb) => cb.value).join(',');

        this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
            nodeId: this.nodeId,
            namespace: this.activeNamespace,
            descriptorKey: 'groupFilter',
            value: filterValue,
        });
    }

    /**
     * Render signal preview chart.
     */
    _renderSignalPreviewChart(container, props) {
        container.className = 'signal-preview-container';

        const canvas = document.createElement('canvas');
        canvas.className = 'signal-preview-canvas';
        canvas.width = 280;
        canvas.height = 120;
        container.appendChild(canvas);

        const hint = document.createElement('div');
        hint.className = 'config-hint signal-preview-hint';
        hint.textContent = 'Loading preview...';
        container.appendChild(hint);

        // Preview is rendered by the data selector cascade via _refreshSignalPreview
        // after dropdown population completes with resolved IDs. This avoids a
        // redundant fetch with potentially stale snapshot IDs.
    }

    /**
     * Render signal preview data on canvas.
     */
    async _renderSignalPreviewData(canvas, hint, props) {
        // Accept either seriesId or datasetId (seriesId is preferred)
        const seriesId = props.seriesId;
        const datasetId = props.datasetId;
        const timeColumn = props.timeColumn;
        const valueColumn = props.valueColumn;
        const groupByColumn = props.groupByColumn || '';
        const aggregationFunction = props.aggregationFunction || 'sum';
        const groupFilter = props.groupFilter || '';

        if ((!seriesId && !datasetId) || !timeColumn || !valueColumn) {
            hint.textContent = 'Select dataset and columns to see preview';
            hint.style.visibility = 'visible';
            return;
        }

        // Check client-side cache to avoid redundant API calls
        const cacheKey = `preview:${seriesId || datasetId}:${timeColumn}:${valueColumn}:${groupByColumn}:${aggregationFunction}:${groupFilter}`;
        if (!this._signalPreviewCache) {
            this._signalPreviewCache = new Map();
        }

        const cached = this._signalPreviewCache.get(cacheKey);
        if (cached) {
            hint.style.visibility = 'hidden';
            this._drawSignalChart(canvas, cached.times, cached.values, props.interpolation);
            return;
        }

        hint.textContent = 'Loading preview...';
        hint.style.visibility = 'visible';

        try {
            const api = window.pywebview?.api;
            if (!api?.get_signal_preview) {
                hint.textContent = 'Preview not available';
                return;
            }

            const previewOptions = {
                series_id: seriesId,
                dataset_id: datasetId,
                time_column: timeColumn,
                value_column: valueColumn,
            };
            if (groupByColumn) {
                previewOptions.group_by_column = groupByColumn;
                previewOptions.aggregation_function = aggregationFunction;
                if (groupFilter) {
                    previewOptions.group_filter = groupFilter;
                }
            }

            const result = await apiCallWithTimeout(() => api.get_signal_preview(previewOptions));

            if (!result?.ok || !Array.isArray(result.times) || !Array.isArray(result.values)) {
                hint.textContent = result?.error || 'Failed to load preview';
                return;
            }

            const times = result.times;
            const values = result.values;

            if (times.length === 0) {
                hint.textContent = 'No data points';
                return;
            }

            // Cache the result to avoid redundant API calls
            this._signalPreviewCache.set(cacheKey, { times, values });

            // Limit cache size to prevent memory issues
            if (this._signalPreviewCache.size > 20) {
                const firstKey = this._signalPreviewCache.keys().next().value;
                this._signalPreviewCache.delete(firstKey);
            }

            hint.style.visibility = 'hidden';
            this._drawSignalChart(canvas, times, values, props.interpolation);
        } catch (err) {
            this.logger?.warn?.('panel', 'Failed to render signal preview', { err });
            hint.textContent = 'Failed to load preview';
        }
    }

    /**
     * Draw signal chart on canvas.
     */
    _drawSignalChart(canvas, times, values, interpolation = 'linear') {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        const padding = { top: 10, right: 10, bottom: 20, left: 40 };
        const plotWidth = width - padding.left - padding.right;
        const plotHeight = height - padding.top - padding.bottom;

        // Clear canvas
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, width, height);

        if (times.length === 0) return;

        // Calculate bounds
        const tMin = Math.min(...times);
        const tMax = Math.max(...times);
        const vMin = Math.min(...values);
        const vMax = Math.max(...values);
        const tRange = tMax - tMin || 1;
        const vRange = vMax - vMin || 1;

        // Scale functions
        const scaleX = (t) => padding.left + ((t - tMin) / tRange) * plotWidth;
        const scaleY = (v) => padding.top + plotHeight - ((v - vMin) / vRange) * plotHeight;

        // Draw grid
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 0.5;
        for (let i = 0; i <= 4; i++) {
            const y = padding.top + (i / 4) * plotHeight;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(width - padding.right, y);
            ctx.stroke();
        }

        // Draw signal line
        ctx.strokeStyle = '#268bd2';
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        for (let i = 0; i < times.length; i++) {
            const x = scaleX(times[i]);
            const y = scaleY(values[i]);

            if (i === 0) {
                ctx.moveTo(x, y);
            } else if (interpolation === 'step') {
                // Step interpolation: draw horizontal then vertical
                const prevX = scaleX(times[i - 1]);
                const prevY = scaleY(values[i - 1]);
                ctx.lineTo(x, prevY);
                ctx.lineTo(x, y);
            } else {
                // Linear interpolation
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();

        // Draw data points
        ctx.fillStyle = '#268bd2';
        for (let i = 0; i < times.length; i++) {
            const x = scaleX(times[i]);
            const y = scaleY(values[i]);
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, Math.PI * 2);
            ctx.fill();
        }

        // Draw axis labels
        ctx.fillStyle = '#888';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(tMin.toFixed(1), padding.left, height - 4);
        ctx.fillText(tMax.toFixed(1), width - padding.right, height - 4);

        ctx.textAlign = 'right';
        ctx.fillText(vMax.toFixed(1), padding.left - 4, padding.top + 4);
        ctx.fillText(vMin.toFixed(1), padding.left - 4, height - padding.bottom);
    }

    /**
     * Render generator preview chart.
     */
    _renderGeneratorPreviewChart(container, props) {
        container.className = 'signal-preview-container';

        const canvas = document.createElement('canvas');
        canvas.className = 'signal-preview-canvas';
        canvas.width = 280;
        canvas.height = 120;
        container.appendChild(canvas);

        const hint = document.createElement('div');
        hint.className = 'config-hint signal-preview-hint';
        container.appendChild(hint);

        if (props.generatorType === 'random') {
            this._drawRandomPreview(canvas, hint, props);
        } else {
            this._drawRampPreview(canvas, hint, props);
        }
    }

    /**
     * Draw ramp generator preview.
     */
    _drawRampPreview(canvas, hint, props) {
        const {
            rampMode = 'linear',
            startValue = 0,
            endValue = 1,
            startTime = 0,
            riseTime = 1,
            endTime = 10,
            fallTime = 0,
        } = props;

        // Generate sample points for the ramp
        const numPoints = 100;
        const totalDuration = endTime + fallTime + 1;  // Extra buffer after fall
        const times = [];
        const values = [];

        for (let i = 0; i <= numPoints; i++) {
            const t = (i / numPoints) * totalDuration;
            times.push(t);
            values.push(this._computeRampValue(t, startValue, endValue, startTime, riseTime, endTime, fallTime, rampMode));
        }

        hint.style.display = 'none';
        this._drawSignalChart(canvas, times, values, 'linear');
    }

    /**
     * Compute ramp value at time t (mirrors function_registry.py ramp function).
     */
    _computeRampValue(t, startValue, endValue, startTime, riseTime, endTime, fallTime, mode) {
        // Before ramp starts
        if (t < startTime) {
            return startValue;
        }

        // During rise phase
        const riseEnd = startTime + riseTime;
        if (t < riseEnd) {
            const progress = riseTime > 0 ? (t - startTime) / riseTime : 1;
            const smoothed = mode === 'smoothstep' ? this._smoothstep(progress) : progress;
            return startValue + (endValue - startValue) * smoothed;
        }

        // Plateau phase (at endValue)
        if (t < endTime) {
            return endValue;
        }

        // During fall phase
        const fallEnd = endTime + fallTime;
        if (t < fallEnd && fallTime > 0) {
            const progress = (t - endTime) / fallTime;
            const smoothed = mode === 'smoothstep' ? this._smoothstep(progress) : progress;
            return endValue + (startValue - endValue) * smoothed;
        }

        // After fall phase
        return startValue;
    }

    /**
     * Smoothstep interpolation function.
     */
    _smoothstep(x) {
        const t = Math.max(0, Math.min(1, x));
        return t * t * (3 - 2 * t);
    }

    /**
     * Draw random generator preview (shows distribution bounds).
     */
    _drawRandomPreview(canvas, hint, props) {
        const {
            randomDistribution = 'uniform',
            randomMin = 0,
            randomMax = 1,
            randomMean = 0,
            randomStdDev = 1,
        } = props;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        const padding = { top: 10, right: 10, bottom: 20, left: 40 };
        const plotWidth = width - padding.left - padding.right;
        const plotHeight = height - padding.top - padding.bottom;

        // Clear canvas
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, width, height);

        if (randomDistribution === 'uniform') {
            // Draw uniform distribution as a rectangle
            const minY = padding.top + plotHeight * 0.2;
            const maxY = padding.top + plotHeight * 0.8;

            // Draw shaded region
            ctx.fillStyle = 'rgba(38, 139, 210, 0.3)';
            ctx.fillRect(padding.left, minY, plotWidth, maxY - minY);

            // Draw borders
            ctx.strokeStyle = '#268bd2';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(padding.left, minY);
            ctx.lineTo(padding.left + plotWidth, minY);
            ctx.moveTo(padding.left, maxY);
            ctx.lineTo(padding.left + plotWidth, maxY);
            ctx.stroke();

            // Labels
            ctx.fillStyle = '#888';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(`max: ${randomMax}`, padding.left - 4, minY + 4);
            ctx.fillText(`min: ${randomMin}`, padding.left - 4, maxY + 4);

            hint.textContent = `Uniform [${randomMin}, ${randomMax}]`;
            hint.style.display = 'block';
        } else {
            // Draw normal distribution bell curve
            const numPoints = 100;
            const range = randomStdDev * 4;  // Show ±4 std devs
            const xMin = randomMean - range;
            const xMax = randomMean + range;

            const times = [];
            const values = [];

            for (let i = 0; i <= numPoints; i++) {
                const x = xMin + (i / numPoints) * (xMax - xMin);
                times.push(x);
                // Normal distribution PDF
                const z = (x - randomMean) / randomStdDev;
                const pdf = Math.exp(-0.5 * z * z) / (randomStdDev * Math.sqrt(2 * Math.PI));
                values.push(pdf);
            }

            hint.textContent = `Normal μ=${randomMean}, σ=${randomStdDev}`;
            hint.style.display = 'block';
            this._drawSignalChart(canvas, times, values, 'linear');
        }
    }

    /**
     * Render smooth function preview chart.
     */
    _renderSmoothFunctionPreviewChart(container, props) {
        container.className = 'signal-preview-container';

        const canvas = document.createElement('canvas');
        canvas.className = 'signal-preview-canvas';
        canvas.width = 280;
        canvas.height = 120;
        container.appendChild(canvas);

        const hint = document.createElement('div');
        hint.className = 'config-hint signal-preview-hint';
        container.appendChild(hint);

        this._drawSmoothFunctionPreview(canvas, hint, props);
    }

    /**
     * Draw smooth function preview based on function type.
     */
    _drawSmoothFunctionPreview(canvas, hint, props) {
        const { functionType = 'logistic' } = props;
        const numPoints = 100;
        const times = [];
        const values = [];

        // Determine appropriate x-range based on function type
        let xMin, xMax, formula;

        switch (functionType) {
            case 'logistic': {
                const { logisticCapacity = 1, logisticGrowth = 1, logisticMidpoint = 0 } = props;
                // Center around midpoint, extend 5 units each direction scaled by growth
                const spread = Math.max(5 / Math.abs(logisticGrowth || 1), 2);
                xMin = logisticMidpoint - spread;
                xMax = logisticMidpoint + spread;
                for (let i = 0; i <= numPoints; i++) {
                    const x = xMin + (i / numPoints) * (xMax - xMin);
                    times.push(x);
                    // L / (1 + e^(-k*(x-x0)))
                    const y = logisticCapacity / (1 + Math.exp(-logisticGrowth * (x - logisticMidpoint)));
                    values.push(y);
                }
                formula = `L/(1+e^(-k(x-x₀)))`;
                break;
            }
            case 'tanh': {
                const { tanhSteepness = 1 } = props;
                const spread = Math.max(3 / Math.abs(tanhSteepness || 1), 2);
                xMin = -spread;
                xMax = spread;
                for (let i = 0; i <= numPoints; i++) {
                    const x = xMin + (i / numPoints) * (xMax - xMin);
                    times.push(x);
                    values.push(Math.tanh(tanhSteepness * x));
                }
                formula = `tanh(kx)`;
                break;
            }
            case 'erf': {
                const { erfScale = 1 } = props;
                const spread = Math.max(3 / Math.abs(erfScale || 1), 2);
                xMin = -spread;
                xMax = spread;
                for (let i = 0; i <= numPoints; i++) {
                    const x = xMin + (i / numPoints) * (xMax - xMin);
                    times.push(x);
                    values.push(this._erf(erfScale * x));
                }
                formula = `erf(sx)`;
                break;
            }
            case 'hill': {
                const { hillCoefficient = 2, hillMidpoint = 1 } = props;
                xMin = 0;
                xMax = hillMidpoint * 4;
                for (let i = 0; i <= numPoints; i++) {
                    const x = xMin + (i / numPoints) * (xMax - xMin);
                    times.push(x);
                    // x^n / (K^n + x^n)
                    const xn = Math.pow(Math.max(x, 0), hillCoefficient);
                    const Kn = Math.pow(hillMidpoint, hillCoefficient);
                    values.push(xn / (Kn + xn));
                }
                formula = `x^n/(K^n+x^n)`;
                break;
            }
            case 'softplus': {
                const { softplusBeta = 1 } = props;
                const spread = Math.max(5 / Math.abs(softplusBeta || 1), 3);
                xMin = -spread;
                xMax = spread;
                for (let i = 0; i <= numPoints; i++) {
                    const x = xMin + (i / numPoints) * (xMax - xMin);
                    times.push(x);
                    // (1/beta) * log(1 + e^(beta*x))
                    const bx = softplusBeta * x;
                    // Use log1p for numerical stability when bx is large
                    const y = bx > 20 ? x : (1 / softplusBeta) * Math.log(1 + Math.exp(bx));
                    values.push(y);
                }
                formula = `(1/β)log(1+e^(βx))`;
                break;
            }
            case 'gompertz': {
                const { gompertzAsymptote = 1, gompertzDisplacement = 1, gompertzGrowth = 1 } = props;
                xMin = -1;
                xMax = Math.max(5 / Math.abs(gompertzGrowth || 1), 5);
                for (let i = 0; i <= numPoints; i++) {
                    const x = xMin + (i / numPoints) * (xMax - xMin);
                    times.push(x);
                    // a * e^(-b * e^(-c*x))
                    const y = gompertzAsymptote * Math.exp(-gompertzDisplacement * Math.exp(-gompertzGrowth * x));
                    values.push(y);
                }
                formula = `ae^(-be^(-cx))`;
                break;
            }
            default:
                hint.textContent = 'Unknown function type';
                hint.style.display = 'block';
                return;
        }

        hint.textContent = formula;
        hint.style.display = 'block';
        this._drawSignalChart(canvas, times, values, 'linear');
    }

    /**
     * Error function approximation (Horner form).
     */
    _erf(x) {
        const sign = x < 0 ? -1 : 1;
        x = Math.abs(x);

        const a1 =  0.254829592;
        const a2 = -0.284496736;
        const a3 =  1.421413741;
        const a4 = -1.453152027;
        const a5 =  1.061405429;
        const p  =  0.3275911;

        const t = 1 / (1 + p * x);
        const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

        return sign * y;
    }

    _renderField(field, idx, sectionId) {
        const fieldId = field.id ?? `${sectionId}-field-${idx}`;
        const wrapper = document.createElement('div');
        const wrapperClasses = ['config-row'];
        if (field.className) {
            wrapperClasses.push(...String(field.className).split(/\s+/).filter(Boolean));
        }
        if (field.variant) {
            wrapperClasses.push(`config-row--${field.variant}`);
        }
        if (field.meta?.className) {
            wrapperClasses.push(...String(field.meta.className).split(/\s+/).filter(Boolean));
        }
        if (field.meta?.variant) {
            wrapperClasses.push(`config-row--${field.meta.variant}`);
        }
        wrapper.className = wrapperClasses.join(' ');

        // Skip label for custom/expression fields unless explicitly requested; autocomplete uses explicit skipLabel
        const typePrefersInlineLabel = field.type === 'custom' || field.type === 'expression';
        const shouldSkipLabel = (typePrefersInlineLabel && field.skipLabel !== false) || field.skipLabel === true;
        if (field.label && !shouldSkipLabel) {
            const labelEl = document.createElement('label');
            labelEl.className = 'config-label';
            labelEl.textContent = field.label;
            if (fieldId) {
                labelEl.setAttribute('for', fieldId);
            }
            wrapper.appendChild(labelEl);
        }

        const control = this._createFieldControl(field, fieldId);
        control.classList.add('config-input');
        control.id = control.id || fieldId;
        if (field.key) {
            control.setAttribute('data-field', field.key);
            control.name = control.name || field.key;
            control.setAttribute('data-descriptor-key', field.key);
        }
        wrapper.appendChild(control);

        // Skip helper text for expression/autocomplete fields (they render their own helper internally)
        if (field.helperText && field.type !== 'expression' && field.type !== 'autocomplete') {
            const helper = document.createElement('div');
            helper.className = 'config-hint';
            helper.textContent = field.helperText;
            wrapper.appendChild(helper);
        }

        this.inputBindings.set(fieldId, { field, element: control });
        return wrapper;
    }

    _createFieldControl(field, fieldId) {
        const type = field.type ?? 'text';
        let element;
        const emitsOnInput = Boolean(field.emitOnInput ?? field.emitsOnInput);
        switch (type) {
            case 'custom':
                element = document.createElement('div');
                element.className = 'config-custom-field';
                if (typeof field.render === 'function') {
                    try {
                        field.render(element, {
                            field,
                            nodeId: this.nodeId,
                            namespace: this.activeNamespace,
                            descriptor: this.currentDescriptor,
                            panel: this,
                            // Provide updateSnapshot so custom fields can persist changes
                            updateSnapshot: (patch, options = {}) => {
                                if (!this.nodeId) return;
                                const nodePlatform = window.__ECOSIM_JS_NEW__?.nodePlatform;
                                if (nodePlatform?.updateNodeSnapshot) {
                                    nodePlatform.updateNodeSnapshot(this.nodeId, patch, options);
                                }
                            },
                        });
                    } catch (err) {
                        this.logger?.warn?.('panel', 'Custom field render failed', { fieldId, err });
                    }
                }
                break;
            case 'textarea':
                element = document.createElement('textarea');
                break;
            case 'select':
                element = document.createElement('select');
                (field.options ?? []).forEach((option) => {
                    const opt = document.createElement('option');
                    opt.value = option.value;
                    opt.textContent = option.label ?? option.value;
                    if (option.value === field.value) {
                        opt.selected = true;
                    }
                    if (option.disabled) {
                        opt.disabled = true;
                    }
                    element.appendChild(opt);
                });
                break;
            case 'expression':
                element = this.#createExpressionField(field, fieldId);
                break;
            case 'autocomplete':
                element = this.#createAutocompleteField(field, fieldId);
                break;
            case 'slider':
                element = this.#createSliderField(field, fieldId);
                break;
            case 'toggle':
                element = this.#createToggleField(field, fieldId);
                break;
            case 'number':
            case 'text':
            default:
                element = document.createElement('input');
                element.type = type === 'number' ? 'number' : 'text';
                if (type === 'number') {
                    // Allow decimals by default; honor explicit step/min/max when provided
                    element.step = field.step ?? 'any';
                    element.inputMode = 'decimal';
                    if (field.min !== null && field.min !== undefined) element.min = field.min;
                    if (field.max !== null && field.max !== undefined) element.max = field.max;
                }
                break;
        }

        if (field.placeholder && type !== 'toggle') {
            element.placeholder = field.placeholder;
        }
        if (field.value !== undefined && field.value !== null) {
            element.value = field.value;
        }
        if (field.disabled && type !== 'toggle') {
            element.disabled = true;
        }

        // Custom fields manage their own input handlers - don't attach generic listeners
        // that would capture bubbling events from child elements
        if (type !== 'expression' && type !== 'slider' && type !== 'custom' && type !== 'toggle') {
            element.addEventListener('change', (event) => this._handleInputChanged(fieldId, field, event.target.value));
            element.addEventListener('input', (event) => {
                if (emitsOnInput) {
                    this._handleInputChanged(fieldId, field, event.target.value, { immediate: true });
                }
            });
        }

        return element;
    }

    #createExpressionField(field, fieldId) {
        const expressionField = new ExpressionField({
            fieldId,
            field,
            namespaceId: this.activeNamespace,
            expressionServices: this.expressionServices,
            logger: this.logger,
            onChange: (value, options = {}) => this._handleInputChanged(fieldId, field, value, options),
        });
        this.expressionFields.set(fieldId, expressionField);
        return expressionField.render();
    }

    #createAutocompleteField(field, fieldId) {
        // Build provider function that returns autocomplete entries
        // `value` is the fragment (variable name part), not the full qualified name
        // `namespace` is the selected namespace from the dropdown (UUID or '__ALL__')
        const expressionProvider = ({ value, namespace, scope }) => {
            if (!this.expressionServices) {
                return [];
            }
            try {
                const fallbackNamespace = this.activeNamespace || null;
                const hasExplicitNamespace = namespace !== undefined;
                const requestedNamespace = namespace && namespace !== '__ALL__' ? namespace : null;
                const scopeAll = scope === 'all' || namespace === '__ALL__';
                // Only fall back when the field did not supply a namespace
                const targetNamespace = hasExplicitNamespace ? requestedNamespace : (fallbackNamespace ?? null);
                const includeCrossNamespace = scopeAll || !targetNamespace;

                // Ask expression services to scope by namespace when selected so we don't leak
                // entries from other tabs. Keep cross-namespace suggestions only when viewing all.
                const entries = this.expressionServices.buildAutocompleteEntries({
                    namespaceId: targetNamespace,
                    includeCrossNamespace,
                    includeDisplayNames: false,
                    includeStocks: true,
                    includeOperators: false,
                    includeSnippets: false,
                    includeConstants: false,
                }) || [];

                // Namespace scoping: when viewing all, keep everything; otherwise enforce selection
                const namespaced = scopeAll
                    ? entries
                    : (targetNamespace
                        ? entries.filter((entry) => (entry?.metadata?.namespaceId ?? null) === targetNamespace)
                        : entries.filter((entry) => {
                            const entryNs = entry?.metadata?.namespaceId ?? null;
                            return !entryNs || entryNs === fallbackNamespace;
                        }));

                // Filter out the current node's own variable (self-reference doesn't make sense)
                const currentNodeId = this.nodeId;
                const filtered = currentNodeId
                    ? namespaced.filter((entry) => entry?.metadata?.nodeId !== currentNodeId)
                    : namespaced;

                // When "All" is selected, qualify variable names with namespace prefix
                // so users can see which namespace each variable belongs to
                const qualified = scopeAll
                    ? filtered.map((entry) => {
                        const entryNsId = entry?.metadata?.namespaceId;
                        if (!entryNsId || entry.type === 'stock' || entry.type === 'function' || entry.type === 'constant') {
                            return entry;
                        }
                        // Look up namespace display name
                        const nsLabel = this.#resolveNamespaceLabel(entryNsId);
                        if (!nsLabel) {
                            return entry;
                        }
                        // Create fully qualified name: Namespace.variable_name
                        const qualifiedLabel = `${nsLabel}.${entry.label}`;
                        return {
                            ...entry,
                            label: qualifiedLabel,
                            insertText: qualifiedLabel,
                            iconType: 'variable-qualified',
                        };
                    })
                    : filtered;

                // Alphabetical sort by label for consistent ordering (A-Z)
                const sorted = (qualified || []).slice().sort((a, b) => {
                    const aLabel = (a?.label || '').toLowerCase();
                    const bLabel = (b?.label || '').toLowerCase();
                    if (aLabel === bLabel) return 0;
                    return aLabel < bLabel ? -1 : 1;
                });

                // Text fragment filter (case-insensitive)
                const fragment = (value || '').toLowerCase().trim();
                if (!fragment) {
                    return sorted;
                }

                return sorted.filter((entry) => (entry.label || '').toLowerCase().includes(fragment));
            } catch (err) {
                this.logger?.warn?.('panel', 'Autocomplete provider error', { err });
                return [];
            }
        };

        // Allow custom provider per field when supplied (e.g., sector/account autocomplete)
        const provider = typeof field.provider === 'function'
            ? (args) => {
                try {
                    return field.provider(args) || [];
                } catch (err) {
                    this.logger?.warn?.('panel', 'Custom autocomplete provider error', { err });
                    return [];
                }
            }
            : expressionProvider;

        const namespaceOptions = this.#buildNamespaceOptions(field);

        // Honor any in-session namespace override (persisted selection before snapshot round-trip)
        if (!this.namespaceOverrides) {
            this.namespaceOverrides = new Map();
        }
        const overrideNamespace = this.namespaceOverrides.get(fieldId);
        if (overrideNamespace) {
            field = { ...field, namespace: overrideNamespace };
        }

        const autocompleteField = new AutocompleteField({
            fieldId,
            field,
            provider,
            logger: this.logger,
            namespace: field.namespace ?? this.activeNamespace,
            namespaceOptions,
            showNamespaceSelect: field.showNamespaceSelect ?? namespaceOptions.length > 0,
            variant: field.variant,
            showNamespaceChip: field.showNamespaceChip,
            allowScopeToggle: field.allowScopeToggle,
            namespaceLabel: field.namespaceLabel,
            scopeMode: field.scopeMode,
            skipNamespacePrefix: Boolean(field.skipNamespacePrefix),
            onChange: (value, options = {}) => this._handleInputChanged(fieldId, field, value, options),
        });
        // Store for cleanup if needed
        if (!this.autocompleteFields) {
            this.autocompleteFields = new Map();
        }
        this.autocompleteFields.set(fieldId, autocompleteField);
        return autocompleteField.render();
    }

    #buildNamespaceOptions(field = {}) {
        const options = [];
        const seen = new Set();
        const push = (opt) => {
            if (!opt || !opt.value || seen.has(opt.value)) return;
            const label = opt.label ?? opt.value;
            const token = opt.token ?? label;
            options.push({ value: opt.value, label, token });
            seen.add(opt.value);
        };

        // Add "All" option first
        push({ value: '__ALL__', label: 'All' });

        // If field provides explicit options, use them
        if (field.namespaceOptions && Array.isArray(field.namespaceOptions)) {
            field.namespaceOptions.forEach((opt) => push(opt));
        }

        // Get all namespaces from data manager with proper display names
        if (this.dataManager && typeof this.dataManager.listNamespaces === 'function') {
            const namespaces = this.dataManager.listNamespaces() || [];
            // Sort by tabIndex for consistent ordering
            namespaces
                .slice()
                .sort((a, b) => (a.tabIndex ?? 0) - (b.tabIndex ?? 0))
                .forEach((ns) => {
                    if (!ns || !ns.id) return;
                    const label = ns.displayName || ns.name || ns.slug || ns.id;
                    const token = ns.slug || ns.displayName || ns.name || label || ns.id;
                    push({ value: ns.id, label, token });
                });
        }

        // Guarantee the active namespace is selectable even if dataManager is empty
        if (this.activeNamespace && !seen.has(this.activeNamespace)) {
            const fallbackLabel = field.namespaceLabel || 'This Tab';
            push({ value: this.activeNamespace, label: fallbackLabel, token: fallbackLabel });
        }

        return options;
    }

    /**
     * Resolve namespace UUID to display label
     */
    #resolveNamespaceLabel(namespaceId) {
        if (!namespaceId || namespaceId === '__ALL__') {
            return null;
        }
        if (this.dataManager && typeof this.dataManager.listNamespaces === 'function') {
            const namespaces = this.dataManager.listNamespaces() || [];
            const ns = namespaces.find((n) => n?.id === namespaceId);
            if (ns) {
                return ns.displayName || ns.name || ns.slug || null;
            }
        }
        return null;
    }

    #createSliderField(field, fieldId) {
        const sliderField = new SliderField({
            fieldId,
            field,
            logger: this.logger,
            onChange: (value, options = {}) => this._handleInputChanged(fieldId, field, value, options),
        });
        this.sliderFields.set(fieldId, sliderField);
        return sliderField.render();
    }

    #createToggleField(field, fieldId) {
        const wrapper = document.createElement('div');
        wrapper.className = 'toggle-field';
        
        const toggle = document.createElement('div');
        toggle.className = 'toggle-switch';
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('tabindex', '0');
        
        let isChecked = Boolean(field.value);
        
        const updateVisual = () => {
            toggle.classList.toggle('toggle-switch--checked', isChecked);
            toggle.setAttribute('aria-checked', String(isChecked));
        };
        updateVisual();
        
        if (field.disabled) {
            toggle.classList.add('toggle-switch--disabled');
            wrapper.classList.add('toggle-field--disabled');
        } else {
            toggle.addEventListener('click', () => {
                isChecked = !isChecked;
                updateVisual();
                this._handleInputChanged(fieldId, field, isChecked);
            });
            
            toggle.addEventListener('keydown', (e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    isChecked = !isChecked;
                    updateVisual();
                    this._handleInputChanged(fieldId, field, isChecked);
                }
            });
        }
        
        wrapper.appendChild(toggle);
        
        Object.defineProperty(wrapper, 'value', {
            get: () => isChecked,
            set: (val) => { 
                isChecked = Boolean(val); 
                updateVisual();
            }
        });
        Object.defineProperty(wrapper, 'checked', {
            get: () => isChecked,
            set: (val) => { 
                isChecked = Boolean(val); 
                updateVisual();
            }
        });
        
        return wrapper;
    }

    #wireDataEvents() {
        if (!this.eventBus || this._wiredDataEvents) {
            return;
        }
        try {
            const offRename = this.eventBus.on('data:variables:renamed', (payload) => this.#handleVariableRenamed(payload));
            this.trackDisposer(offRename);

            const offSimulationCompleted = this.eventBus.on('simulation:run:completed', () => this.#handleSimulationCompleted());
            this.trackDisposer(offSimulationCompleted);

            this._wiredDataEvents = true;
        } catch (err) {
            this.logger?.warn?.('panel', 'Failed to register variable rename listener', { err });
        }
    }

    #handleSimulationCompleted() {
        if (!this.container || !this.currentDescriptor) {
            return;
        }

        // The plot X-axis selector renders a warning banner until the first run produces metadata.
        const hasSimulationData = Boolean(this.dataManager?.metadata?.lastSimulationDataset);
        if (!hasSimulationData) {
            return;
        }

        const hasSolarizedWarning = Boolean(this.container.querySelector('.config-warning--solarized'));
        if (!hasSolarizedWarning) {
            return;
        }

        // Re-render the current descriptor so the warning banner is removed immediately.
        try {
            this.renderDescriptor(this.currentDescriptor);
        } catch (err) {
            this.logger?.warn?.('panel', 'Failed to refresh panel after simulation completion', { err });
        }
    }

    #handleVariableRenamed(event) {
        const detail = event?.detail || event;
        const oldKey = detail?.oldKey;
        const newKey = detail?.newKey;
        const namespaceId = detail?.namespaceId ?? detail?.namespace;
        if (!oldKey || !newKey || oldKey === newKey) {
            return;
        }

        const namespaceToken = this.#resolveNamespaceToken(namespaceId);

        // Update expression fields (used heavily by nodes)
        this.expressionFields.forEach((component, fieldId) => {
            if (!component?.getValue) return;
            const current = component.getValue();
            if (typeof current !== 'string' || !current) return;

            const targetNamespace = component.namespaceId || this.activeNamespace;
            let next = current;

            // Replace bare tokens when the field lives in the same namespace
            if (!namespaceId || !targetNamespace || targetNamespace === namespaceId) {
                next = this.#replaceToken(next, oldKey, newKey);
            }

            // Replace qualified tokens when the namespace is known
            if (namespaceToken) {
                next = this.#replaceToken(next, `${namespaceToken}.${oldKey}`, `${namespaceToken}.${newKey}`);
            }

            if (next !== current) {
                component.setValue(next);
                const binding = this.inputBindings.get(fieldId);
                const field = binding?.field ?? { id: fieldId };
                this._handleInputChanged(fieldId, field, next, { immediate: false });
            }
        });

        // Update autocomplete fields (single-value variable selectors)
        if (this.autocompleteFields) {
            this.autocompleteFields.forEach((component, fieldId) => {
                if (!component) return;
                const current = component.getValue?.() ?? component.input?.value ?? '';
                if (typeof current !== 'string' || !current) return;

                const targetNamespace = component.namespace ?? this.activeNamespace ?? null;
                const selectedNamespace = component.selectedNamespace ?? targetNamespace;
                let next = current;

                const canReplaceBare = !namespaceId || (selectedNamespace && selectedNamespace === namespaceId) || (targetNamespace && targetNamespace === namespaceId);
                if (canReplaceBare) {
                    next = this.#replaceToken(next, oldKey, newKey);
                }

                if (namespaceToken) {
                    next = this.#replaceToken(next, `${namespaceToken}.${oldKey}`, `${namespaceToken}.${newKey}`);
                }

                if (next !== current) {
                    component.setComposedValue?.(next);
                    const updatedValue = component.getValue?.() ?? next;
                    const binding = this.inputBindings.get(fieldId);
                    const field = binding?.field ?? { id: fieldId };
                    this._handleInputChanged(fieldId, field, updatedValue, { immediate: false });
                }
            });
        }
    }

    #replaceToken(text, from, to) {
        return ExpressionServices.replaceToken(text, from, to);
    }

    #resolveNamespaceToken(namespaceId) {
        if (!namespaceId || !this.dataManager?.listNamespaces) {
            return null;
        }
        const namespaces = this.dataManager.listNamespaces() || [];
        const ns = namespaces.find((entry) => entry?.id === namespaceId);
        if (!ns) {
            return null;
        }
        const candidates = [ns.slug, ns.displayName, ns.name, ns.id];
        for (const candidate of candidates) {
            if (!candidate) continue;
            const sanitized = this.#sanitizeNamespaceCandidate(candidate);
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(sanitized)) {
                return sanitized;
            }
        }
        return null;
    }

    #sanitizeNamespaceCandidate(value) {
        const source = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
        if (!source) {
            return '';
        }
        let sanitized = source.replace(/[^A-Za-z0-9_]/g, '_');
        if (!/^[A-Za-z_]/.test(sanitized)) {
            sanitized = `N_${sanitized}`;
        }
        return sanitized;
    }

    _handleInputChanged(fieldId, field, value, options = {}) {
        const payload = {
            nodeId: this.nodeId,
            namespace: this.activeNamespace,
            fieldId,
            descriptorKey: field.key ?? fieldId,
            value,
            immediate: Boolean(options.immediate),
        };
        if (options.namespace !== undefined && field.namespaceMetaKey) {
            if (!this.namespaceOverrides) {
                this.namespaceOverrides = new Map();
            }
            this.namespaceOverrides.set(fieldId, options.namespace);
            // Emit a parallel update for the namespace selection
            this.eventBus?.emit(EVENTS.INPUT_CHANGED, {
                nodeId: this.nodeId,
                namespace: this.activeNamespace,
                fieldId: `${fieldId}:namespace`,
                descriptorKey: field.namespaceMetaKey,
                value: options.namespace,
                immediate: false,
            });
        }
        if (this._editLocked) return;
        this.eventBus?.emit(EVENTS.INPUT_CHANGED, payload);
    }

    _handleActionTriggered(sectionId, action) {
        this.eventBus?.emit(EVENTS.ACTION_TRIGGERED, {
            nodeId: this.nodeId,
            namespace: this.activeNamespace,
            sectionId,
            actionId: action.id ?? action.label,
            descriptorKey: action.key ?? action.id,
        });
    }

    _clearPanel() {
        this._disposeSections();
        this.#disposeExpressionFields();
        this.#disposeSliderFields();
        this.#disposeAutocompleteFields();
        if (this.container) {
            this.container.innerHTML = '';
        }
        this.inputBindings.clear();
    }

    _disposeSections() {
        this.sectionInstances.clear();
    }

    #disposeExpressionFields() {
        this.expressionFields.forEach((component) => {
            try {
                component?.dispose?.();
            } catch (error) {
                this.logger?.warn?.('panel', 'Failed to dispose expression field', { error });
            }
        });
        this.expressionFields.clear();
    }

    #disposeSliderFields() {
        this.sliderFields.forEach((component) => {
            try {
                component?.dispose?.();
            } catch (error) {
                this.logger?.warn?.('panel', 'Failed to dispose slider field', { error });
            }
        });
        this.sliderFields.clear();
    }

    #disposeAutocompleteFields() {
        if (!this.autocompleteFields) return;
        this.autocompleteFields.forEach((component) => {
            try {
                component?.dispose?.();
            } catch (error) {
                this.logger?.warn?.('panel', 'Failed to dispose autocomplete field', { error });
            }
        });
        this.autocompleteFields.clear();
    }
}

PanelController.EVENTS = EVENTS;
