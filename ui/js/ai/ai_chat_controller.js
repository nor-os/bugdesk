/**
 * AI Chat Controller.
 *
 * Orchestrates the AI chat lifecycle: manages the AiStateMachine,
 * dispatches messages to the backend, handles streaming responses,
 * coordinates the AiProjectApplier for applying changes,
 * manages model selection, and handles local LLM lifecycle.
 *
 * @module ai/ai_chat_controller
 */

import { ControllerBase } from '../ui/base/controller_base.js';
import { AiStateMachine, AI_STATES, AI_BUS_EVENTS } from './ai_state_machine.js';
import { AiProjectApplier } from './ai_project_applier.js';
import { AiChatComponent } from './ai_chat_component.js';
import { AiDiffRenderer } from './ai_diff_renderer.js';
import { ManagedWindow } from '../ui/components/managed_window.js';
import { getSetting, setSetting } from '../core/settings.js';



const STATUS_POLL_INTERVAL = 2000;
const CHAT_STORAGE_KEY = 'ecoagent:ai-chat:tabs';


export class AiChatController extends ControllerBase {

    /** @type {AiStateMachine} */
    #stateMachine;

    /** @type {AiProjectApplier} */
    #applier;

    /** @type {AiChatComponent} */
    #component;

    /** @type {AiDiffRenderer} */
    #diffRenderer;

    /** @type {import('../data/project_model.js').ProjectModel} */
    #projectModel;

    /** @type {import('../workspace/history_service.js').HistoryService} */
    #historyService;

    /** @type {number|null} */
    #statusPollTimer = null;

    /** @type {object|null} Detected backend info */
    #detectedBackends = null;

    /** @type {string} Last known local LLM status */
    #lastLocalStatus = 'stopped';

    /** @type {string|null} Actual model name reported by the backend */
    #loadedModelName = null;

    /** @type {ManagedWindow|null} */
    #serverModalWindow = null;

    /** @type {HTMLElement|null} Cached modal content root */
    #serverModalContent = null;

    /** @type {ManagedWindow|null} */
    #cloudModalWindow = null;

    /** @type {HTMLElement|null} */
    #cloudModalContent = null;

    /** @type {Map<string, Array<{id: string, name: string}>>} Per-provider cached model lists */
    #cloudModelsMap = new Map();

    /** @type {Array<{id: string, name: string, baseUrl: string, type: string}>} */
    #cloudProviders = [];


    /** Maps message index -> { batchAction, applied, operations } for apply/unapply */
    #messageBatchActions = new Map();

    /** Pending batch from #applyOperations, finalized after addAssistantMessage creates the DOM */
    #pendingBatch = null;

    /** Set by the streaming bridge when onStreamComplete fires — guards #handleSend catch block */
    #streamFinalized = false;

    /** Whether an incremental operation batch is in progress during streaming */
    #incrementalBatchStarted = false;

    /** All operations applied incrementally during streaming, for finalization */
    #allIncrementalOps = [];

    /**
     * Multi-tab state.
     * @type {Map<string, {conversationId: string|null, title: string, messages: Array, scrollPos: number}>}
     */
    #tabs = new Map();
    #activeTabId = null;
    #tabCounter = 0;

    /**
     * @param {object} deps
     * @param {import('../core/event_bus.js').default} deps.eventBus
     * @param {import('../data/project_model.js').ProjectModel} deps.projectModel
     * @param {import('../workspace/history_service.js').HistoryService} [deps.historyService]
     * @param {object} [deps.logger]
     */
    constructor(deps) {
        super(deps);
        this.#projectModel = deps.projectModel;
        this.#historyService = deps.historyService || null;
    }

    initialize() {
        const { eventBus, logger } = this;

        // State machine
        this.#stateMachine = new AiStateMachine({ eventBus, logger });

        // Operation applier
        this.#applier = new AiProjectApplier({
            projectModel: this.#projectModel,
            eventBus,
            logger,
        });

        // Diff renderer
        this.#diffRenderer = new AiDiffRenderer();

        // Chat component
        this.#component = new AiChatComponent({ eventBus, logger });

        // Mount component into the collapsible box content area
        const container = document.getElementById('right-collapsible-content-ai-chat');
        if (container) {
            this.#component.mount(container, {
                stateMachine: this.#stateMachine,
                diffRenderer: this.#diffRenderer,
                onSend: (message) => this.#handleSend(message),
                onCancel: () => this.#handleCancel(),
                onToggleAllOperations: (messageIndex) => this.#handleToggleAllOperations(messageIndex),
                onToggleOperation: (messageIndex, actionIndex) => this.#handleToggleOperation(messageIndex, actionIndex),
                onNewChat: () => this.#handleNewChat(),
                onModeChange: (mode) => {
                    this.#stateMachine.setMode(mode);
                    setSetting('ai.defaultMode', mode);
                },
                onModelChange: (selection) => this.#handleModelChange(selection),
                onLocalAction: (action) => this.#handleLocalAction(action),
                onManageServer: () => this.#openServerModal(),
                onManageCloud: () => this.#openCloudModal(),
                onTabSwitch: (tabId) => this.#switchTab(tabId),
                onTabClose: (tabId) => this.#closeTab(tabId),
                onTabAdd: () => this.#createTab(),
                onTabReset: () => this.#resetTab(),
                onTabRename: (tabId, newTitle) => this.#renameTab(tabId, newTitle),
            });
        }

        // Restore persisted mode (ask/edit)
        const savedMode = getSetting('ai.defaultMode', 'ask');
        if (savedMode !== 'ask') {
            this.#stateMachine.setMode(savedMode);
        }

        // Restore persisted tabs or create a fresh one
        if (!this.#restoreTabs()) {
            this.#createTab('New chat');
        }

        // Set up the streaming bridge
        this.#setupStreamingBridge();

        // Sync model display from current settings
        this.#syncModelDisplay();

        // Load cloud provider registry and auto-fetch models for saved keys
        this.#loadCloudProviders();

        // Detect local backends on startup
        this.#detectBackends();
    }

    dispose() {
        this.#saveTabs();
        this.#stopStatusPolling();
        this.#serverModalWindow?.close();
        this.#serverModalWindow = null;
        this.#serverModalContent = null;
        this.#cloudModalWindow?.close();
        this.#cloudModalWindow = null;
        this.#cloudModalContent = null;
        this.#component?.dispose();
        this.#diffRenderer?.dispose();
        // Clean up streaming bridge
        if (window.__ecosim_ai) {
            delete window.__ecosim_ai;
        }
        super.dispose();
    }

    // ─── Model selection ─────────────────────────────────────────────────

    /**
     * Handle model change from the dropdown.
     * @param {{ provider: string, model: string }} selection
     */
    #handleModelChange(selection) {
        const { provider, model } = selection;

        setSetting('ai.provider', provider);

        if (provider !== 'local') {
            setSetting('ai.cloud.providerId', provider);
            setSetting(`ai.cloud.providers.${provider}.model`, model);
            this.#stopStatusPolling();
        }

        this.#syncModelDisplay();
    }

    /**
     * Read current settings and update the component display accordingly.
     */
    #syncModelDisplay() {
        const provider = getSetting('ai.provider', '');

        if (provider && provider !== 'local') {
            // Cloud provider
            const modelId = getSetting(`ai.cloud.providers.${provider}.model`, '');
            const hasAuth = !!getSetting(`ai.cloud.providers.${provider}.apiKey`, '');

            if (hasAuth && modelId) {
                const models = this.#cloudModelsMap.get(provider) || [];
                const model = models.find(m => m.id === modelId);
                const displayName = model?.name || modelId;
                this.#component.updateModelDisplay(displayName);
                this.#component.setActiveModel(provider, modelId);
            } else {
                this.#component.updateModelDisplay('Select model...');
                this.#component.setActiveModel('', '');
            }
        } else if (provider === 'local') {
            const localModel = this.#loadedModelName || getSetting('ai.local.modelPath', '') || 'Local model';
            this.#component.updateModelDisplay(localModel);
            this.#component.setActiveModel('local', 'local');
        } else {
            this.#component.updateModelDisplay('Select model...');
            this.#component.setActiveModel('', '');
        }

        this.#updateStatusIndicator();
    }

    // ─── Provider readiness ─────────────────────────────────────────────

    /**
     * Check whether the current AI provider is ready to accept messages.
     * @returns {{ ready: boolean, label: string }}
     */
    #checkProviderReadiness() {
        const provider = getSetting('ai.provider', '');
        if (provider && provider !== 'local') {
            // Cloud provider
            const hasModel = !!getSetting(`ai.cloud.providers.${provider}.model`, '');
            const hasAuth = !!getSetting(`ai.cloud.providers.${provider}.apiKey`, '');
            if (!hasAuth) return { ready: false, label: 'No API key' };
            if (!hasModel) return { ready: false, label: 'No model selected' };
            const models = this.#cloudModelsMap.get(provider) || [];
            const ready = hasAuth && hasModel && models.length > 0;
            return { ready, label: ready ? 'Ready' : 'Verifying...' };
        }
        if (!provider) {
            return { ready: false, label: 'No provider' };
        }
        // Local provider: check cached status
        const localStatus = this.#lastLocalStatus;
        const isReady = localStatus === 'running' || localStatus === 'connected';
        const labels = {
            stopped: 'Stopped', starting: 'Starting...',
            running: 'Running', connected: 'Connected', error: 'Error',
        };
        const label = (localStatus === 'starting' && this.#lastStatusMessage)
            ? this.#lastStatusMessage
            : labels[localStatus] || 'Stopped';
        return { ready: isReady, label };
    }

    /**
     * Update the header dot indicator to reflect provider readiness.
     */
    #updateStatusIndicator() {
        const dot = document.getElementById('ai-status-indicator');
        if (!dot) return;

        const { ready, label } = this.#checkProviderReadiness();
        const isStarting = this.#lastLocalStatus === 'starting';

        dot.className = 'ai-status-dot';
        if (ready) {
            dot.classList.add('ai-status-dot--ready');
        } else if (isStarting) {
            dot.classList.add('ai-status-dot--starting');
        }
        // Default (no extra class) = gray (#555)
        dot.title = label;
    }

    // ─── Server Modal ─────────────────────────────────────────────────────

    #openServerModal() {
        if (this.#serverModalWindow?.isVisible) {
            this.#serverModalWindow.bringToFront();
            return;
        }

        this.#serverModalContent = this.#buildServerModalContent();

        this.#serverModalWindow = new ManagedWindow({
            id: 'ai-server-modal',
            title: 'Manage AI Server',
            icon: 'dns',
            content: this.#serverModalContent,
            minWidth: 380,
            minHeight: 280,
            defaultWidth: 420,
            defaultHeight: 460,
            canMinimize: false,
            canMaximize: false,
            canResize: false,
            modal: true,
            onClose: () => {
                this.#serverModalWindow = null;
                this.#serverModalContent = null;
            },
        });
        this.#serverModalWindow.show();

        // Push current status into modal
        this.#updateServerModal();

        // Lazily fetch LM Studio models on modal open if that backend is selected
        const serverType = getSetting('ai.local.serverType', 'llamacpp');
        if (serverType === 'lmstudio' && this.#detectedBackends?.lmstudio) {
            this.#fetchLmStudioModels().then(() => this.#pushLocalStatus());
        }
    }

    #buildServerModalContent() {
        const root = document.createElement('div');
        root.className = 'ai-server-modal';

        root.innerHTML = `
            <div class="ai-server-modal__row">
                <span class="ai-server-modal__label">Status</span>
                <span class="ai-server-modal__dot ai-server-modal__dot--stopped"></span>
                <span class="ai-server-modal__status-text">Stopped</span>
            </div>
            <div class="ai-server-modal__row">
                <span class="ai-server-modal__label">Backend</span>
                <select class="ai-server-modal__select" data-field="backend">
                    <option value="llamacpp">llama.cpp</option>
                    <option value="ollama">Ollama</option>
                    <option value="lmstudio">LM Studio</option>
                    <option value="vllm">vLLM</option>
                    <option value="external">External URL</option>
                </select>
            </div>
            <div class="ai-server-modal__row" data-backend-mode="file">
                <span class="ai-server-modal__label">Model</span>
                <span class="ai-server-modal__value ai-server-modal__model-text">None selected</span>
            </div>
            <div class="ai-server-modal__row" data-backend-mode="ollama" style="display:none;">
                <span class="ai-server-modal__label">Model</span>
                <select class="ai-server-modal__model-select" data-field="ollama-model">
                    <option value="">No models found</option>
                </select>
            </div>
            <div class="ai-server-modal__row" data-backend-mode="lmstudio" style="display:none;">
                <span class="ai-server-modal__label">Model</span>
                <select class="ai-server-modal__model-select" data-field="lmstudio-model">
                    <option value="">No models found</option>
                </select>
            </div>
            <div class="ai-server-modal__row" data-backend-mode="lmstudio" style="display:none;">
                <span class="ai-server-modal__label">Context</span>
                <input type="number" class="ai-server-modal__number-input" data-field="lmstudio-context"
                    value="32768" min="2048" max="131072" step="1024">
                <span class="ai-server-modal__hint-inline" data-field="lmstudio-context-hint"></span>
            </div>
            <div class="ai-server-modal__row" data-backend-mode="external" style="display:none;">
                <span class="ai-server-modal__label">URL</span>
                <input type="text" class="ai-server-modal__url-input"
                    placeholder="http://127.0.0.1:8080/v1" data-field="external-url">
            </div>
            <div class="ai-server-modal__hint" data-backend-mode="external" style="display:none;">
                Any OpenAI-compatible /v1/chat/completions endpoint
            </div>
            <div class="ai-server-modal__separator">
                <span>Advanced</span>
            </div>
            <div class="ai-server-modal__row ai-server-modal__advanced-row">
                <span class="ai-server-modal__label">Port</span>
                <input type="number" class="ai-server-modal__number-input" data-field="port"
                    value="8080" min="1024" max="65535">
            </div>
            <div class="ai-server-modal__row ai-server-modal__advanced-row" data-backend-mode="file">
                <span class="ai-server-modal__label">GPU Layers</span>
                <input type="number" class="ai-server-modal__number-input" data-field="gpu-layers"
                    value="-1" min="-1" max="999">
            </div>
            <div class="ai-server-modal__row ai-server-modal__advanced-row" data-backend-mode="managed-only">
                <span class="ai-server-modal__label">Context</span>
                <input type="number" class="ai-server-modal__number-input" data-field="context-length"
                    value="32768" min="2048" max="131072" step="1024">
            </div>
            <div class="ai-server-modal__row ai-server-modal__advanced-row" data-backend-mode="lmstudio" style="display:none;">
                <span class="ai-server-modal__label">Flash Attn</span>
                <label class="ai-server-modal__checkbox-label">
                    <input type="checkbox" class="ai-server-modal__checkbox" data-field="flash-attention" checked>
                    <span>Enabled</span>
                </label>
            </div>
            <div class="ai-server-modal__row ai-server-modal__advanced-row" data-backend-mode="lmstudio" style="display:none;">
                <span class="ai-server-modal__label">Eval Batch</span>
                <input type="number" class="ai-server-modal__number-input" data-field="eval-batch-size"
                    value="512" min="1" max="4096" step="64">
            </div>
            <div class="ai-server-modal__row ai-server-modal__advanced-row" data-backend-mode="lmstudio" style="display:none;">
                <span class="ai-server-modal__label">KV Cache</span>
                <label class="ai-server-modal__checkbox-label">
                    <input type="checkbox" class="ai-server-modal__checkbox" data-field="kv-cache-on-gpu" checked>
                    <span>Offload to GPU</span>
                </label>
            </div>
            <div class="ai-server-modal__error" style="display:none;"></div>
            <div class="ai-server-modal__setup" style="display:none;">
                No local LLM backend detected.<br>
                Install <a href="https://lmstudio.ai" target="_blank">LM Studio</a>,
                <a href="https://ollama.com" target="_blank">Ollama</a>,
                or <a href="https://github.com/ggml-org/llama.cpp/releases" target="_blank">llama.cpp</a>
                and ensure the CLI is on your PATH.
            </div>
            <div class="ai-server-modal__actions" data-backend-mode="managed">
                <button class="ai-server-modal__btn" data-action="browse">Select model...</button>
                <button class="ai-server-modal__btn ai-server-modal__btn--primary" data-action="start">Start</button>
            </div>
            <div class="ai-server-modal__actions" data-backend-mode="external" style="display:none;">
                <button class="ai-server-modal__btn ai-server-modal__btn--primary" data-action="connect" style="flex:1;">Connect</button>
            </div>
        `;

        // Bind events
        this.#bindServerModalEvents(root);

        return root;
    }

    #bindServerModalEvents(root) {
        // Backend selector
        root.querySelector('[data-field="backend"]')?.addEventListener('change', (e) => {
            this.#handleLocalAction('backend-change', e.target.value);
            this.#switchServerModalMode(e.target.value);
        });

        // Ollama model selector
        root.querySelector('[data-field="ollama-model"]')?.addEventListener('change', (e) => {
            this.#handleLocalAction('ollama-model-change', e.target.value);
        });

        // LM Studio model selector
        root.querySelector('[data-field="lmstudio-model"]')?.addEventListener('change', (e) => {
            this.#handleLocalAction('lmstudio-model-change', e.target.value);
        });

        // External URL — connect on Enter
        root.querySelector('[data-field="external-url"]')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.#handleLocalAction('connect', e.target.value);
            }
        });

        // Advanced fields — persist on change
        root.querySelector('[data-field="port"]')?.addEventListener('change', (e) => {
            setSetting('ai.local.port', parseInt(e.target.value, 10) || 8080);
        });
        root.querySelector('[data-field="gpu-layers"]')?.addEventListener('change', (e) => {
            setSetting('ai.local.gpuLayers', parseInt(e.target.value, 10));
        });
        root.querySelector('[data-field="context-length"]')?.addEventListener('change', (e) => {
            setSetting('ai.local.contextLength', parseInt(e.target.value, 10) || 32768);
        });
        root.querySelector('[data-field="lmstudio-context"]')?.addEventListener('change', (e) => {
            setSetting('ai.local.contextLength', parseInt(e.target.value, 10) || 32768);
        });
        root.querySelector('[data-field="flash-attention"]')?.addEventListener('change', (e) => {
            setSetting('ai.local.flashAttention', e.target.checked);
        });
        root.querySelector('[data-field="eval-batch-size"]')?.addEventListener('change', (e) => {
            setSetting('ai.local.evalBatchSize', parseInt(e.target.value, 10) || 512);
        });
        root.querySelector('[data-field="kv-cache-on-gpu"]')?.addEventListener('change', (e) => {
            setSetting('ai.local.kvCacheOnGpu', e.target.checked);
        });

        // Action buttons
        root.querySelectorAll('.ai-server-modal__btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                if (!action) return;
                if (action === 'connect') {
                    const urlInput = root.querySelector('[data-field="external-url"]');
                    this.#handleLocalAction(action, urlInput?.value || '');
                } else {
                    this.#handleLocalAction(action);
                }
            });
        });
    }

    /**
     * Switch visible rows in the server modal based on backend type.
     * @param {'llamacpp'|'vllm'|'ollama'|'lmstudio'|'external'} backend
     */
    #switchServerModalMode(backend) {
        const root = this.#serverModalContent;
        if (!root) return;

        const isExternal = backend === 'external';
        const isOllama = backend === 'ollama';
        const isLmStudio = backend === 'lmstudio';
        const hasDropdownModels = isOllama || isLmStudio;

        // File-based model row
        root.querySelector('[data-backend-mode="file"]').style.display = (!isExternal && !hasDropdownModels) ? '' : 'none';

        // Ollama model row
        root.querySelector('[data-backend-mode="ollama"]').style.display = isOllama ? '' : 'none';

        // LM Studio rows (model + context)
        root.querySelectorAll('[data-backend-mode="lmstudio"]:not(.ai-server-modal__advanced-row)').forEach(el => {
            el.style.display = isLmStudio ? '' : 'none';
        });

        // External URL rows
        root.querySelectorAll('[data-backend-mode="external"]').forEach(el => {
            el.style.display = isExternal ? '' : 'none';
        });

        // Managed action buttons
        const managedActions = root.querySelector('[data-backend-mode="managed"]');
        if (managedActions) managedActions.style.display = isExternal ? 'none' : '';

        // Hide browse for backends with model dropdowns
        const browseBtn = root.querySelector('[data-action="browse"]');
        if (browseBtn) browseBtn.style.display = hasDropdownModels ? 'none' : '';

        // GPU layers only for file-based backends
        const gpuRow = root.querySelector('.ai-server-modal__advanced-row[data-backend-mode="file"]');
        if (gpuRow) gpuRow.style.display = (!isExternal && !hasDropdownModels) ? '' : 'none';

        // Generic context row: hidden for external AND lmstudio (lmstudio has its own inline context)
        const ctxRow = root.querySelector('[data-backend-mode="managed-only"]');
        if (ctxRow) ctxRow.style.display = (isExternal || isLmStudio) ? 'none' : '';

        // LM Studio-specific advanced rows
        root.querySelectorAll('.ai-server-modal__advanced-row[data-backend-mode="lmstudio"]').forEach(el => {
            el.style.display = isLmStudio ? '' : 'none';
        });
    }

    /**
     * Update the server modal content to reflect current state.
     */
    #updateServerModal() {
        const root = this.#serverModalContent;
        if (!root) return;

        const modelPath = getSetting('ai.local.modelPath', '');
        const serverType = getSetting('ai.local.serverType', 'llamacpp');
        const externalUrl = getSetting('ai.local.baseUrl', '');
        const status = this.#lastLocalStatus;
        const statusMessage = this.#lastStatusMessage;
        const backends = this.#detectedBackends || { llamacpp: false, ollama: false, lmstudio: false, vllm: false };

        // Status dot + text
        const dot = root.querySelector('.ai-server-modal__dot');
        const statusText = root.querySelector('.ai-server-modal__status-text');
        if (dot) {
            dot.className = 'ai-server-modal__dot';
            dot.classList.add(`ai-server-modal__dot--${status}`);
        }
        if (statusText) {
            const labels = {
                stopped: 'Stopped', starting: 'Starting...', running: 'Running',
                error: 'Error', connected: 'Connected',
            };
            // Show detailed progress message during startup if available
            statusText.textContent = (status === 'starting' && statusMessage)
                ? statusMessage
                : labels[status] || status;
        }

        // Backend selector
        const backendSelect = root.querySelector('[data-field="backend"]');
        if (backendSelect) {
            for (const opt of backendSelect.options) {
                if (opt.value === 'external') continue;
                opt.disabled = !backends[opt.value];
            }
            backendSelect.value = serverType;
            backendSelect.disabled = status === 'running' || status === 'starting';
        }

        this.#switchServerModalMode(serverType);

        // Model path (file-based)
        const modelText = root.querySelector('.ai-server-modal__model-text');
        if (modelText) {
            if (modelPath) {
                const filename = modelPath.split(/[/\\]/).pop();
                modelText.textContent = filename;
                modelText.title = modelPath;
            } else {
                modelText.textContent = 'None selected';
                modelText.title = '';
            }
        }

        // Ollama model dropdown
        this.#populateModalModelSelect(
            root.querySelector('[data-field="ollama-model"]'),
            this.#ollamaModels, modelPath, status,
            'No models found \u2014 pull with ollama',
        );

        // LM Studio model dropdown
        this.#populateModalModelSelect(
            root.querySelector('[data-field="lmstudio-model"]'),
            this.#lmstudioModels, modelPath, status,
            'Start to list models',
        );

        // LM Studio inline context field
        const lmsCtxInput = root.querySelector('[data-field="lmstudio-context"]');
        if (lmsCtxInput && !lmsCtxInput.matches(':focus')) {
            const ctxVal = getSetting('ai.local.contextLength', 32768);
            lmsCtxInput.value = ctxVal;
            // Set max from selected model's capability
            const selectedModel = this.#lmstudioModels.find(m => m.name === modelPath);
            if (selectedModel?.maxContextLength) {
                lmsCtxInput.max = selectedModel.maxContextLength;
                const hint = root.querySelector('[data-field="lmstudio-context-hint"]');
                if (hint) {
                    const maxK = Math.round(selectedModel.maxContextLength / 1024);
                    hint.textContent = `max ${maxK}k`;
                }
            }
        }

        // External URL input
        const urlInput = root.querySelector('[data-field="external-url"]');
        if (urlInput && !urlInput.matches(':focus')) {
            urlInput.value = externalUrl || '';
        }

        // Advanced fields
        const portInput = root.querySelector('[data-field="port"]');
        if (portInput && !portInput.matches(':focus')) {
            portInput.value = getSetting('ai.local.port', 8080);
        }
        const gpuInput = root.querySelector('[data-field="gpu-layers"]');
        if (gpuInput && !gpuInput.matches(':focus')) {
            gpuInput.value = getSetting('ai.local.gpuLayers', -1);
        }
        const ctxInput = root.querySelector('[data-field="context-length"]');
        if (ctxInput && !ctxInput.matches(':focus')) {
            ctxInput.value = getSetting('ai.local.contextLength', 32768);
        }
        const flashAttnInput = root.querySelector('[data-field="flash-attention"]');
        if (flashAttnInput) {
            flashAttnInput.checked = getSetting('ai.local.flashAttention', true);
        }
        const evalBatchInput = root.querySelector('[data-field="eval-batch-size"]');
        if (evalBatchInput && !evalBatchInput.matches(':focus')) {
            evalBatchInput.value = getSetting('ai.local.evalBatchSize', 512);
        }
        const kvCacheInput = root.querySelector('[data-field="kv-cache-on-gpu"]');
        if (kvCacheInput) {
            kvCacheInput.checked = getSetting('ai.local.kvCacheOnGpu', true);
        }

        // Error display
        const errorEl = root.querySelector('.ai-server-modal__error');
        if (errorEl) {
            const err = this.#lastLocalError;
            if (err && status === 'error') {
                errorEl.textContent = err;
                errorEl.style.display = '';
            } else {
                errorEl.style.display = 'none';
            }
        }

        // Setup instructions (no backend detected at all)
        const setupEl = root.querySelector('.ai-server-modal__setup');
        if (setupEl) {
            const hasAny = backends.llamacpp || backends.ollama || backends.lmstudio || backends.vllm;
            setupEl.style.display = hasAny ? 'none' : '';
        }

        // Action buttons — re-read modelPath in case auto-select updated it during populate
        const effectiveModelPath = getSetting('ai.local.modelPath', '');
        const browseBtn = root.querySelector('[data-action="browse"]');
        const startStopBtn = root.querySelector(
            '[data-backend-mode="managed"] [data-action="start"], [data-backend-mode="managed"] [data-action="stop"]'
        );
        const hasBackend = backends.llamacpp || backends.ollama || backends.lmstudio || backends.vllm;

        if (browseBtn) {
            browseBtn.disabled = status === 'running' || status === 'starting';
        }
        if (startStopBtn) {
            if (status === 'running') {
                startStopBtn.dataset.action = 'stop';
                startStopBtn.textContent = 'Stop';
                startStopBtn.disabled = false;
                startStopBtn.className = 'ai-server-modal__btn ai-server-modal__btn--danger';
            } else if (status === 'starting') {
                startStopBtn.dataset.action = 'cancel-start';
                startStopBtn.textContent = 'Cancel';
                startStopBtn.disabled = false;
                startStopBtn.className = 'ai-server-modal__btn ai-server-modal__btn--danger';
            } else {
                const managedBackend = serverType === 'lmstudio' || serverType === 'ollama';
                startStopBtn.dataset.action = 'start';
                startStopBtn.textContent = 'Start';
                startStopBtn.disabled = !hasBackend || (!managedBackend && !effectiveModelPath);
                startStopBtn.className = 'ai-server-modal__btn ai-server-modal__btn--primary';
            }
        }

        // External connect button
        const connectBtn = root.querySelector('[data-action="connect"]');
        if (connectBtn) {
            if (status === 'connected') {
                connectBtn.textContent = 'Disconnect';
                connectBtn.dataset.action = 'disconnect';
                connectBtn.className = 'ai-server-modal__btn ai-server-modal__btn--danger';
            } else {
                connectBtn.textContent = 'Connect';
                connectBtn.dataset.action = 'connect';
                connectBtn.className = 'ai-server-modal__btn ai-server-modal__btn--primary';
            }
        }
    }

    /**
     * Populate a model <select> in the server modal.
     */
    #populateModalModelSelect(selectEl, models, modelPath, status, emptyLabel) {
        if (!selectEl) return;

        const currentVal = selectEl.value;
        selectEl.innerHTML = '';

        if (models.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = emptyLabel;
            selectEl.appendChild(opt);
        } else {
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m.name;
                let text = m.label || m.name + (m.size ? ` (${m.size})` : '');
                if (m.maxContextLength) {
                    const ctx = m.maxContextLength >= 1024
                        ? `${Math.round(m.maxContextLength / 1024)}k`
                        : `${m.maxContextLength}`;
                    text += ` [${ctx} ctx]`;
                }
                opt.textContent = text;
                selectEl.appendChild(opt);
            }
            if (modelPath && [...selectEl.options].some(o => o.value === modelPath)) {
                selectEl.value = modelPath;
            } else if (currentVal && [...selectEl.options].some(o => o.value === currentVal)) {
                selectEl.value = currentVal;
            } else if (models.length > 0 && !modelPath) {
                selectEl.value = models[0].name;
                setSetting('ai.local.modelPath', models[0].name);
            }
        }
        selectEl.disabled = status === 'running' || status === 'starting';
    }

    // ─── Cloud Provider Modal ────────────────────────────────────────────

    #openCloudModal() {
        if (this.#cloudModalWindow?.isVisible) {
            this.#cloudModalWindow.bringToFront();
            return;
        }

        this.#cloudModalContent = this.#buildCloudModalContent();

        this.#cloudModalWindow = new ManagedWindow({
            id: 'ai-cloud-modal',
            title: 'Configure Cloud Provider',
            icon: 'cloud',
            content: this.#cloudModalContent,
            minWidth: 380,
            minHeight: 280,
            defaultWidth: 420,
            defaultHeight: 440,
            canMinimize: false,
            canMaximize: false,
            canResize: false,
            modal: true,
            onClose: () => {
                this.#cloudModalWindow = null;
                this.#cloudModalContent = null;
            },
        });
        this.#cloudModalWindow.show();
        this.#updateCloudModal();
    }

    #buildCloudModalContent() {
        const root = document.createElement('div');
        root.className = 'ai-cloud-modal';

        const providerOptions = this.#cloudProviders
            .map(p => `<option value="${p.id}">${p.name}</option>`)
            .join('');

        root.innerHTML = `
            <div class="ai-cloud-modal__auth-panel">
                <div class="ai-cloud-modal__row">
                    <span class="ai-cloud-modal__label">Provider</span>
                    <select class="ai-cloud-modal__select" data-field="provider">
                        ${providerOptions}
                    </select>
                </div>
                <div class="ai-cloud-modal__row" data-field-group="custom-url" style="display:none;">
                    <span class="ai-cloud-modal__label">Base URL</span>
                    <input type="text" class="ai-cloud-modal__url-input"
                        data-field="base-url" placeholder="https://api.example.com/v1">
                </div>
                <div class="ai-cloud-modal__row">
                    <span class="ai-cloud-modal__label">API Key</span>
                    <input type="password" class="ai-cloud-modal__key-input"
                        data-field="api-key" placeholder="sk-...">
                </div>
                <div class="ai-cloud-modal__hint">
                    Stored locally, never shared.
                </div>
                <div class="ai-cloud-modal__actions">
                    <button class="ai-cloud-modal__btn ai-cloud-modal__btn--primary"
                        data-action="verify">Verify &amp; Load Models</button>
                </div>
            </div>

            <div class="ai-cloud-modal__error" style="display:none;"></div>
            <div class="ai-cloud-modal__separator">
                <span>Models</span>
            </div>
            <div class="ai-cloud-modal__models"></div>
            <div class="ai-cloud-modal__status"></div>
        `;

        this.#bindCloudModalEvents(root);
        return root;
    }

    #bindCloudModalEvents(root) {
        // Provider selector
        root.querySelector('[data-field="provider"]')?.addEventListener('change', (e) => {
            setSetting('ai.cloud.providerId', e.target.value);
            this.#updateCloudModal();
        });

        // Verify button
        root.querySelector('[data-action="verify"]')?.addEventListener('click', () => {
            this.#verifyFromModal();
        });

        // API Key: Enter to verify
        root.querySelector('[data-field="api-key"]')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.#verifyFromModal();
            }
        });
    }

    /** Read current modal inputs and verify the selected cloud provider. */
    #verifyFromModal() {
        const root = this.#cloudModalContent;
        if (!root) return;
        const providerId = root.querySelector('[data-field="provider"]')?.value || 'anthropic';
        const apiKey = root.querySelector('[data-field="api-key"]')?.value || '';
        const baseUrl = root.querySelector('[data-field="base-url"]')?.value || '';
        this.#verifyAndFetchModels(providerId, apiKey, baseUrl);
    }

    #updateCloudModal() {
        const root = this.#cloudModalContent;
        if (!root) return;

        const providerId = getSetting('ai.cloud.providerId', 'anthropic');
        const selectedModel = getSetting(`ai.cloud.providers.${providerId}.model`, '');
        const apiKey = getSetting(`ai.cloud.providers.${providerId}.apiKey`, '');
        const models = this.#cloudModelsMap.get(providerId) || [];

        // ── Provider selector ──
        const providerSelect = root.querySelector('[data-field="provider"]');
        if (providerSelect && !providerSelect.matches(':focus')) {
            providerSelect.value = providerId;
        }

        // ── Custom base URL (only for 'custom' provider) ──
        const customUrlGroup = root.querySelector('[data-field-group="custom-url"]');
        if (customUrlGroup) {
            customUrlGroup.style.display = providerId === 'custom' ? '' : 'none';
        }
        const baseUrlInput = root.querySelector('[data-field="base-url"]');
        if (baseUrlInput && !baseUrlInput.matches(':focus')) {
            baseUrlInput.value = getSetting('ai.cloud.providers.custom.baseUrl', '');
        }

        // ── API Key ──
        const keyInput = root.querySelector('[data-field="api-key"]');
        if (keyInput && !keyInput.matches(':focus')) {
            keyInput.value = apiKey;
        }

        // ── Models list ──
        const modelsContainer = root.querySelector('.ai-cloud-modal__models');
        if (modelsContainer) {
            modelsContainer.innerHTML = '';
            for (const m of models) {
                const row = document.createElement('div');
                row.className = 'ai-cloud-modal__model-row';
                if (m.id === selectedModel) row.classList.add('ai-cloud-modal__model-row--active');
                row.dataset.modelId = m.id;
                row.innerHTML = `
                    <span class="ai-cloud-modal__model-radio">${m.id === selectedModel ? '\u25CF' : '\u25CB'}</span>
                    <span class="ai-cloud-modal__model-name">${m.name}</span>
                `;
                row.addEventListener('click', () => {
                    setSetting(`ai.cloud.providers.${providerId}.model`, m.id);
                    setSetting('ai.cloud.providerId', providerId);
                    setSetting('ai.provider', providerId);
                    this.#component.updateCloudModels(models, providerId);
                    this.#syncModelDisplay();
                    this.#updateCloudModal();
                });
                modelsContainer.appendChild(row);
            }
        }

        // ── Status line ──
        const statusEl = root.querySelector('.ai-cloud-modal__status');
        if (statusEl) {
            if (models.length > 0) {
                statusEl.innerHTML = `<span class="ai-cloud-modal__status-dot ai-cloud-modal__status-dot--ok"></span>
                    Connected \u2014 ${models.length} model${models.length !== 1 ? 's' : ''} available`;
            } else if (apiKey) {
                statusEl.textContent = 'Enter key and click Verify to load models.';
            } else {
                statusEl.textContent = '';
            }
        }
    }

    // ─── API Key Verification ────────────────────────────────────────

    /**
     * Validate an API key and fetch available models for a cloud provider.
     * @param {string} providerId
     * @param {string} apiKey
     * @param {string} [baseUrl='']
     */
    async #verifyAndFetchModels(providerId, apiKey, baseUrl = '') {
        if (!apiKey?.trim() || !providerId) return;

        const root = this.#cloudModalContent;
        const errorEl = root?.querySelector('.ai-cloud-modal__error');
        const verifyBtn = root?.querySelector('[data-action="verify"]');

        // Show loading state
        if (verifyBtn) {
            verifyBtn.disabled = true;
            verifyBtn.textContent = 'Verifying...';
        }
        if (errorEl) errorEl.style.display = 'none';

        try {
            const api = window.pywebview?.api;
            if (!api?.ai_list_cloud_models) {
                throw new Error('AI bridge not available');
            }

            const payload = {
                providerId,
                apiKey: apiKey.trim(),
            };
            if (baseUrl?.trim()) {
                payload.baseUrl = baseUrl.trim();
            }

            const result = await api.ai_list_cloud_models(payload);

            if (result.ok) {
                const models = result.models || [];
                this.#cloudModelsMap.set(providerId, models);
                setSetting(`ai.cloud.providers.${providerId}.apiKey`, apiKey.trim());
                if (providerId === 'custom' && baseUrl?.trim()) {
                    setSetting('ai.cloud.providers.custom.baseUrl', baseUrl.trim());
                }

                // Auto-select first model if none selected
                const currentModel = getSetting(`ai.cloud.providers.${providerId}.model`, '');
                if (!currentModel && models.length > 0) {
                    setSetting(`ai.cloud.providers.${providerId}.model`, models[0].id);
                    setSetting('ai.cloud.providerId', providerId);
                    setSetting('ai.provider', providerId);
                }

                this.#component.updateCloudModels(models, providerId);
                this.#syncModelDisplay();
            } else {
                this.#cloudModelsMap.delete(providerId);
                const activeProvider = getSetting('ai.provider', '');
                if (activeProvider === providerId) {
                    this.#component.updateCloudModels([], providerId);
                }
                if (errorEl) {
                    errorEl.textContent = result.error || 'Verification failed';
                    errorEl.style.display = '';
                }
            }
        } catch (e) {
            this.#cloudModelsMap.delete(providerId);
            const activeProvider = getSetting('ai.provider', '');
            if (activeProvider === providerId) {
                this.#component.updateCloudModels([], providerId);
            }
            if (errorEl) {
                errorEl.textContent = e.message || 'Failed to verify API key';
                errorEl.style.display = '';
            }
        }

        // Restore button
        if (verifyBtn) {
            verifyBtn.disabled = false;
            verifyBtn.textContent = 'Verify & Load Models';
        }

        this.#updateCloudModal();
    }

    /**
     * Fetch the cloud provider registry from the backend, then auto-fetch
     * models for any provider that has a saved API key.
     */
    async #loadCloudProviders() {
        const api = window.pywebview?.api;
        if (!api?.ai_get_cloud_providers) return;

        try {
            const result = await api.ai_get_cloud_providers();
            if (result.ok) {
                this.#cloudProviders = result.providers || [];
            }
        } catch (e) {
            this.logger?.warn?.('[AiChatController] Failed to load cloud providers:', e);
        }

        // Auto-fetch models for the active cloud provider if it has a saved key
        const providerId = getSetting('ai.cloud.providerId', 'anthropic');
        const apiKey = getSetting(`ai.cloud.providers.${providerId}.apiKey`, '');
        if (apiKey) {
            const baseUrl = providerId === 'custom'
                ? getSetting('ai.cloud.providers.custom.baseUrl', '')
                : '';
            await this.#verifyAndFetchModels(providerId, apiKey, baseUrl);
        }
    }

    // ─── Local LLM management ────────────────────────────────────────────

    /** @type {Array} Cached Ollama model list */
    #ollamaModels = [];

    /** @type {string|null} Last local error */
    #lastLocalError = null;

    /** @type {string|null} Human-readable startup progress message */
    #lastStatusMessage = null;

    /** @type {Array} Cached LM Studio model list */
    #lmstudioModels = [];

    async #detectBackends() {
        const api = window.pywebview?.api;
        if (!api?.ai_detect_local_llm) return;

        try {
            const result = await api.ai_detect_local_llm();
            if (result.ok) {
                this.#detectedBackends = {
                    llamacpp: result.llamacpp,
                    llamacpp_path: result.llamacpp_path,
                    ollama: result.ollama,
                    ollama_path: result.ollama_path,
                    lmstudio: result.lmstudio,
                    lmstudio_path: result.lmstudio_path,
                    vllm: result.vllm,
                };

                // Auto-select best available backend
                const available = [];
                if (result.lmstudio) available.push('lmstudio');
                if (result.ollama) available.push('ollama');
                if (result.llamacpp) available.push('llamacpp');
                if (result.vllm) available.push('vllm');

                if (available.length === 1) {
                    setSetting('ai.local.serverType', available[0]);
                }

                // Fetch model lists for detected backends (Ollama only — LM Studio models
                // are fetched on-demand when the user selects the lmstudio backend to
                // avoid auto-launching the LM Studio application on startup)
                if (result.ollama) {
                    await this.#fetchOllamaModels();
                }
            }
        } catch (e) {
            this.logger?.warn?.('[AiChatController] Backend detection failed:', e);
        }

        // Check if a server is already running (survives browser refresh)
        const serverActive = await this.#checkExistingServer();

        if (!serverActive) {
            this.#pushLocalStatus();
        }
    }

    /**
     * Check if the Python backend still has an active LLM server.
     * Restores state after browser refresh.
     * @returns {Promise<boolean>} true if server is starting or running
     */
    async #checkExistingServer() {
        const api = window.pywebview?.api;
        if (!api?.ai_get_llm_status) return false;

        try {
            const result = await api.ai_get_llm_status();
            const status = result.status || 'stopped';

            // Capture the actual loaded model name from the backend
            this.#loadedModelName = result.loaded_model || null;

            if (status === 'starting' || status === 'running') {
                if (result.base_url) {
                    setSetting('ai.local.baseUrl', result.base_url);
                }
                this.#pushLocalStatus({ status, error: result.error });

                if (status === 'starting') {
                    this.#startStatusPolling();
                } else if (status === 'running') {
                    setSetting('ai.provider', 'local');
                    this.#syncModelDisplay();
                }
                return true;
            }
        } catch (e) {
            // Server not available — ignore
        }
        return false;
    }

    async #fetchOllamaModels() {
        const api = window.pywebview?.api;
        if (!api?.ai_list_ollama_models) return;

        try {
            const result = await api.ai_list_ollama_models();
            this.#ollamaModels = result.ok ? (result.models || []) : [];
        } catch (e) {
            this.#ollamaModels = [];
        }
    }

    async #fetchLmStudioModels() {
        const api = window.pywebview?.api;
        if (!api?.ai_list_lmstudio_models) return;

        try {
            const result = await api.ai_list_lmstudio_models();
            this.#lmstudioModels = result.ok ? (result.models || []) : [];
        } catch (e) {
            this.#lmstudioModels = [];
        }
    }

    /**
     * When an LM Studio model is selected, apply its maxContextLength as a
     * constraint on the context input. If the current setting exceeds the
     * model's max, clamp it down. Does NOT overwrite the user's choice.
     */
    #applyLmStudioModelContext(modelName) {
        const model = this.#lmstudioModels.find(m => m.name === modelName);
        if (!model?.maxContextLength) return;

        const maxCtx = model.maxContextLength;
        const current = getSetting('ai.local.contextLength', 32768);

        // Clamp down if current exceeds model's max
        if (current > maxCtx) {
            setSetting('ai.local.contextLength', maxCtx);
        }

        // Update UI if modal is open
        const root = this.#serverModalContent;
        if (!root) return;

        const effectiveCtx = Math.min(current, maxCtx);

        // LM Studio inline context input
        const lmsCtx = root.querySelector('[data-field="lmstudio-context"]');
        if (lmsCtx) {
            lmsCtx.max = maxCtx;
            if (!lmsCtx.matches(':focus')) lmsCtx.value = effectiveCtx;
        }
        // Hint text
        const hint = root.querySelector('[data-field="lmstudio-context-hint"]');
        if (hint) {
            const maxK = Math.round(maxCtx / 1024);
            hint.textContent = `max ${maxK}k`;
        }
        // Generic advanced context input (kept in sync)
        const ctxInput = root.querySelector('[data-field="context-length"]');
        if (ctxInput) {
            ctxInput.max = maxCtx;
            if (!ctxInput.matches(':focus')) ctxInput.value = effectiveCtx;
        }
    }

    /**
     * Handle local management panel actions.
     * @param {string} action
     * @param {string} [value] - Optional value (URL, model name, backend type)
     */
    async #handleLocalAction(action, value) {
        switch (action) {
            case 'browse':
                await this.#browseModelFile();
                break;
            case 'start':
                await this.#startLocalLLM();
                break;
            case 'cancel-start':
            case 'stop':
                await this.#stopLocalLLM();
                break;
            case 'backend-change':
                this.#handleBackendChange(value);
                break;
            case 'ollama-model-change':
                setSetting('ai.local.modelPath', value);
                this.#pushLocalStatus();
                break;
            case 'lmstudio-model-change':
                setSetting('ai.local.modelPath', value);
                this.#applyLmStudioModelContext(value);
                this.#pushLocalStatus();
                break;
            case 'connect':
                this.#connectExternalUrl(value);
                break;
            case 'disconnect':
                this.#disconnectExternalUrl();
                break;
        }
    }

    #handleBackendChange(backend) {
        setSetting('ai.local.serverType', backend);

        // When switching to a dropdown-based backend, refresh model list
        if (backend === 'ollama' && this.#detectedBackends?.ollama) {
            this.#fetchOllamaModels().then(() => this.#pushLocalStatus());
            return;
        }
        if (backend === 'lmstudio' && this.#detectedBackends?.lmstudio) {
            this.#fetchLmStudioModels().then(() => this.#pushLocalStatus());
            return;
        }

        this.#pushLocalStatus();
    }

    #connectExternalUrl(url) {
        if (!url?.trim()) return;

        // Normalize: ensure it ends with /v1 or similar
        let baseUrl = url.trim().replace(/\/+$/, '');
        if (!baseUrl.endsWith('/v1')) {
            baseUrl += '/v1';
        }

        setSetting('ai.local.serverType', 'external');
        setSetting('ai.local.baseUrl', baseUrl);
        setSetting('ai.provider', 'local');

        this.#pushLocalStatus({ status: 'connected', externalUrl: url.trim() });
        this.#syncModelDisplay();
    }

    #disconnectExternalUrl() {
        setSetting('ai.local.baseUrl', '');
        if (getSetting('ai.provider') === 'local') {
            setSetting('ai.provider', '');
        }
        this.#pushLocalStatus({ externalUrl: '' });
        this.#syncModelDisplay();
    }

    async #browseModelFile() {
        const api = window.pywebview?.api;
        if (!api?.ai_browse_model_file) return;

        try {
            const result = await api.ai_browse_model_file();
            if (result.ok && result.path) {
                setSetting('ai.local.modelPath', result.path);
                this.#pushLocalStatus();
            }
        } catch (e) {
            this.logger?.warn?.('[AiChatController] Browse model failed:', e);
        }
    }

    async #startLocalLLM() {
        const api = window.pywebview?.api;
        if (!api?.ai_start_local_llm) return;

        // Immediate visual feedback before the bridge call
        this.#pushLocalStatus({ status: 'starting' });

        const serverType = getSetting('ai.local.serverType', 'llamacpp');
        const config = {
            serverType,
            modelPath: getSetting('ai.local.modelPath', ''),
            port: getSetting('ai.local.port', { ollama: 11434, lmstudio: 1234 }[serverType] || 8080),
            gpuLayers: getSetting('ai.local.gpuLayers', -1),
            contextLength: getSetting('ai.local.contextLength', 32768),
            flashAttention: getSetting('ai.local.flashAttention', true),
            evalBatchSize: getSetting('ai.local.evalBatchSize', 512),
            kvCacheOnGpu: getSetting('ai.local.kvCacheOnGpu', true),
        };

        try {
            const result = await api.ai_start_local_llm(config);
            if (result.ok) {
                if (result.base_url) {
                    setSetting('ai.local.baseUrl', result.base_url);
                }
                this.#startStatusPolling();
            } else if (result.error?.includes('already running')) {
                // Server is already active — poll for status instead of error
                this.#startStatusPolling();
            } else {
                this.#pushLocalStatus({ status: 'error', error: result.error });
            }
        } catch (e) {
            this.logger?.warn?.('[AiChatController] Start local LLM failed:', e);
            this.#pushLocalStatus({ status: 'error', error: e.message });
        }
    }

    async #stopLocalLLM() {
        const api = window.pywebview?.api;
        if (!api?.ai_stop_local_llm) return;

        const wasStarting = this.#lastLocalStatus === 'starting';

        try {
            await api.ai_stop_local_llm();
        } catch (e) {
            this.logger?.warn?.('[AiChatController] Stop local LLM failed:', e);
        }

        this.#stopStatusPolling();
        this.#loadedModelName = null;
        this.#pushLocalStatus({ status: 'stopped' });
        this.#syncModelDisplay();

        // Auto-close modal when cancelling a pending start
        if (wasStarting) {
            this.#serverModalWindow?.close();
        }
    }

    async #pollLocalStatus() {
        const api = window.pywebview?.api;
        if (!api?.ai_get_llm_status) return;

        try {
            const result = await api.ai_get_llm_status();
            const status = result.status || 'stopped';

            // Capture the actual loaded model name from the backend
            this.#loadedModelName = result.loaded_model || null;

            this.#pushLocalStatus({
                status,
                error: result.error,
                statusMessage: result.status_message || null,
            });

            // Stop polling on terminal states
            if (status === 'running' || status === 'stopped' || status === 'error') {
                this.#stopStatusPolling();

                // Auto-switch to local provider when running
                if (status === 'running') {
                    setSetting('ai.provider', 'local');
                    this.#syncModelDisplay();
                    this.#serverModalWindow?.close();
                }
            }
        } catch (e) {
            this.logger?.warn?.('[AiChatController] Status poll failed:', e);
        }
    }

    #startStatusPolling() {
        this.#stopStatusPolling();
        this.#statusPollTimer = setInterval(() => this.#pollLocalStatus(), STATUS_POLL_INTERVAL);
        this.#pollLocalStatus();
    }

    #stopStatusPolling() {
        if (this.#statusPollTimer !== null) {
            clearInterval(this.#statusPollTimer);
            this.#statusPollTimer = null;
        }
    }

    /**
     * Push current local status to the component.
     * @param {object} [overrides]
     */
    #pushLocalStatus(overrides = {}) {
        const modelPath = getSetting('ai.local.modelPath', '');
        const serverType = getSetting('ai.local.serverType', 'llamacpp');
        const externalUrl = getSetting('ai.local.baseUrl', '');
        const status = overrides.status || 'stopped';

        // Cache for readiness checks
        this.#lastLocalStatus = status;
        this.#lastLocalError = overrides.error || null;
        this.#lastStatusMessage = overrides.statusMessage || null;

        this.#component.updateLocalStatus({
            status,
            serverType: overrides.serverType || serverType,
            modelPath,
            error: overrides.error || null,
            statusMessage: overrides.statusMessage || null,
            backends: this.#detectedBackends || { llamacpp: false, ollama: false, lmstudio: false, vllm: false },
            ollamaModels: this.#ollamaModels,
            lmstudioModels: this.#lmstudioModels,
            externalUrl: overrides.externalUrl ?? externalUrl,
        });

        this.#updateStatusIndicator();
        this.#updateServerModal();
    }

    // ─── Streaming bridge ───────────────────────────────────────────────

    #setupStreamingBridge() {
        const self = this;
        const eventBus = this.eventBus;
        const stateMachine = this.#stateMachine;

        window.__ecosim_ai = {
            onStreamChunk(data) {
                const { conversationId, chunk, done } = data;
                if (stateMachine.getState() === AI_STATES.WAITING) {
                    stateMachine.streamStart();
                }
                eventBus.emit(AI_BUS_EVENTS.STREAM_CHUNK, { conversationId, chunk });
            },

            onStreamOperations(data) {
                const { operations } = data;
                if (operations?.length > 0) {
                    self.#applyIncrementalOperations(operations);
                }
            },

            onStreamComplete(data) {
                const { conversationId, operations, dslDiff, responseText,
                        operationsAlreadyApplied } = data;

                // Update conversation tracking before state transition
                if (conversationId) {
                    stateMachine.conversationId = conversationId;
                    const tab = self.#tabs.get(self.#activeTabId);
                    if (tab) tab.conversationId = conversationId;
                }

                if (operationsAlreadyApplied && self.#incrementalBatchStarted) {
                    // Operations were applied incrementally — finalize the batch
                    const batchAction = self.#historyService?.endBatch() || null;
                    self.#applier.resetIdMap();

                    self.#pendingBatch = {
                        batchAction,
                        itemApplied: batchAction
                            ? new Array((batchAction.actions || []).length).fill(true)
                            : null,
                        operations: operations || self.#allIncrementalOps,
                    };
                    self.#incrementalBatchStarted = false;
                    self.#allIncrementalOps = [];
                } else if (operations?.length > 0) {
                    // Fallback: operations delivered at completion (not incrementally)
                    self.#applyOperations(operations);
                }

                // Transition state (async — completes in microtask queue)
                stateMachine.streamComplete({ operations: null, dslDiff, responseText });

                // Finalize the response in the UI (runs synchronously via evaluate_js,
                // before pywebview attempts the return-value callback)
                self.#component.addAssistantMessage(
                    responseText || '', operations, dslDiff,
                );
                self.#finalizeOperationControls();
                self.#streamFinalized = true;
                self.#saveTabs();
            },

            onStreamError(data) {
                const { error } = data;
                if (error === 'cancelled') return; // Already handled by #handleCancel
                // Finalize any partially-applied incremental operations
                if (self.#incrementalBatchStarted) {
                    self.#historyService?.endBatch();
                    self.#applier.resetIdMap();
                    self.#incrementalBatchStarted = false;
                    self.#allIncrementalOps = [];
                }
                stateMachine.error(error || 'Unknown error');
                self.#saveTabs();
            },

            getProjectSnapshot() {
                return {};
            },

            applyProjectOperations(payload) {
                // Unused for internal chat
            },
        };

        // AI stream frames now arrive over the WebSocket push channel: Python
        // broadcasts ai:stream_* via the streaming server (Bridge._emit_ai)
        // instead of pywebview evaluate_js — that crashed the WinForms backend
        // when called from the agent's background thread, and no-op'd entirely
        // in --browser mode. Route those events to the __ecosim_ai handlers
        // above, chaining any existing __ecoagentPush consumer (runtime_controls).
        const AI_STREAM_ROUTES = {
            'ai:stream_chunk':      'onStreamChunk',
            'ai:stream_operations': 'onStreamOperations',
            'ai:stream_complete':   'onStreamComplete',
            'ai:stream_error':      'onStreamError',
        };
        const prevPush = window.__ecoagentPush;
        window.__ecoagentPush = (event, payload) => {
            const method = AI_STREAM_ROUTES[event];
            if (method) {
                try { window.__ecosim_ai?.[method]?.(payload); }
                catch (e) { console.warn('[ai] stream route failed', event, e); }
            }
            try { prevPush?.(event, payload); } catch { /* ignore */ }
        };
    }

    // ─── Message handling ───────────────────────────────────────────────

    async #handleSend(message) {
        if (!message?.trim()) return;
        if (!this.#stateMachine.canSend()) return;

        const mode = this.#stateMachine.mode;
        this.#stateMachine.sendMessage(message, this.#stateMachine.conversationId);

        // Serialize current project
        const workspaceSnapshot = this.#serializeProject();

        // Build settings from app settings
        const settings = this.#getAiSettings();

        // Reset — the streaming bridge sets this when onStreamComplete fires
        this.#streamFinalized = false;
        this.#incrementalBatchStarted = false;
        this.#allIncrementalOps = [];

        // Persist immediately so the user message survives a page reload
        // during the async AI call / streaming phase
        this.#saveTabs();

        const api = window.pywebview?.api;
        if (!api?.ai_send_message) {
            this.#stateMachine.error('AI bridge not available. Is the desktop app running?');
            return;
        }

        // ai_send_message validates synchronously and spawns the agent loop
        // in a background thread.  It returns immediately with {ok, conversationId}
        // for validation results.  All agent-loop results and errors are
        // delivered through the streaming bridge (onStreamComplete / onStreamError).
        try {
            const result = await api.ai_send_message({
                message,
                mode,
                workspaceSnapshot,
                conversationId: this.#stateMachine.conversationId,
                workspacePath: this.#getWorkspacePath(),
                settings,
            });

            if (!result.ok) {
                this.#stateMachine.error(result.error || 'Unknown error');
                return;
            }

            // Update tab title from the original message
            if (result.conversationId) {
                const tab = this.#tabs.get(this.#activeTabId);
                if (tab?.title === 'New chat') {
                    tab.title = message.slice(0, 30) + (message.length > 30 ? '...' : '');
                    this.#renderTabBar();
                    this.#saveTabs();
                }
            }

        } catch (e) {
            this.#stateMachine.error(e.message || 'Failed to send message');
            this.#saveTabs();
        }
    }

    async #handleCancel() {
        if (!this.#stateMachine.isProcessing()) return;

        const api = window.pywebview?.api;
        if (api?.ai_cancel_message) {
            try {
                await api.ai_cancel_message();
            } catch (e) {
                this.logger?.warn?.('[AiChatController] Cancel failed:', e);
            }
        }

        // Finalize any partially-applied incremental operations
        if (this.#incrementalBatchStarted) {
            this.#historyService?.endBatch();
            this.#applier.resetIdMap();
            this.#incrementalBatchStarted = false;
            this.#allIncrementalOps = [];
        }

        this.#stateMachine.cancel();
    }

    /** Toggle all operations for a message. */
    #handleToggleAllOperations(messageIndex) {
        const entry = this.#messageBatchActions.get(messageIndex);
        if (!entry?.operations) return;

        if (entry.allApplied) {
            // Unapply: use HistoryService if available (current session), else use applier
            if (entry.batchAction) {
                this.#historyService?.applyDirect(entry.batchAction, 'undo');
            } else {
                this.#applier.unapply(entry.operations);
            }
            entry.allApplied = false;
            entry.itemApplied?.fill(false);
        } else {
            // Re-apply: use HistoryService if available, else replay operations
            if (entry.batchAction) {
                this.#historyService?.applyDirect(entry.batchAction, 'redo');
            } else {
                this.#applier.apply(entry.operations);
            }
            entry.allApplied = true;
            entry.itemApplied?.fill(true);
        }

        this.#component.markOperationsApplied(messageIndex, entry.allApplied);
        this.#component.markAllItems(messageIndex, entry.allApplied);
    }

    /** Toggle a single operation within a message's batch (current session only). */
    #handleToggleOperation(messageIndex, actionIndex) {
        const entry = this.#messageBatchActions.get(messageIndex);
        if (!entry?.batchAction) return;

        const subActions = entry.batchAction.actions;
        if (actionIndex < 0 || actionIndex >= subActions.length) return;

        const subAction = subActions[actionIndex];
        const wasApplied = entry.itemApplied[actionIndex];

        this.#historyService?.applyDirect(subAction, wasApplied ? 'undo' : 'redo');
        entry.itemApplied[actionIndex] = !wasApplied;
        entry.allApplied = entry.itemApplied.every(Boolean);

        this.#component.markItemApplied(messageIndex, actionIndex, entry.itemApplied[actionIndex]);
        this.#component.markOperationsApplied(messageIndex, entry.allApplied);
    }

    /**
     * Rebuild messageBatchActions from persisted messages.
     * Called on restore/tab switch so undo/redo works after reload.
     */
    #rebuildBatchActions(messages) {
        this.#messageBatchActions.clear();
        if (!messages?.length) return;

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.role === 'assistant' && msg.operations?.length > 0) {
                this.#messageBatchActions.set(i, {
                    batchAction: null,  // HistoryService actions not available after reload
                    allApplied: true,
                    itemApplied: null,
                    operations: msg.operations,
                });
            }
        }
    }

    // ─── Tab management ─────────────────────────────────────────────────

    /**
     * Create a new tab and switch to it.
     * @param {string} [title]
     */
    #createTab(title) {
        this.#tabCounter++;
        const tabId = `tab-${this.#tabCounter}`;
        this.#tabs.set(tabId, {
            conversationId: null,
            title: title || 'New chat',
            messages: [],
            scrollPos: 0,
        });

        // If there was a previous active tab, cache its state
        if (this.#activeTabId && this.#tabs.has(this.#activeTabId)) {
            this.#cacheActiveTabState();
        }

        this.#activeTabId = tabId;
        this.#messageBatchActions.clear();
        this.#pendingBatch = null;
        this.#stateMachine.newConversation();
        this.#component.clearMessages();
        this.#renderTabBar();
        this.#saveTabs();
    }

    /**
     * Reconcile a tab's messages with the backend (SQLite).
     *
     * If the backend has more messages than localStorage (e.g. the assistant
     * response was saved after a mid-stream reload), replace the stale
     * localStorage cache with the authoritative backend data.
     *
     * @param {string} tabId
     */
    async #reconcileTab(tabId) {
        const tab = this.#tabs.get(tabId);
        if (!tab?.conversationId) return;

        const api = window.pywebview?.api;
        if (!api?.ai_get_messages) return;

        try {
            const result = await api.ai_get_messages({
                conversationId: tab.conversationId,
            });
            if (!result?.ok || !result.messages?.length) return;

            // Normalize backend format to frontend format
            const backendMessages = result.messages.map(m => ({
                role: m.role,
                content: m.content,
                operations: m.operations || undefined,
                dslDiff: m.dsl_diff || undefined,
            }));

            // Only update if backend has more messages (stale localStorage)
            if (backendMessages.length <= tab.messages.length) return;

            tab.messages = backendMessages;

            // Update UI if this is the currently displayed tab
            if (tabId === this.#activeTabId) {
                this.#messageBatchActions.clear();
                this.#pendingBatch = null;
                this.#component.restoreMessages(tab.messages);
                this.#rebuildBatchActions(tab.messages);
            }

            this.#saveTabs();
        } catch (e) {
            this.logger?.warn?.('[AiChatController] Tab reconciliation failed:', e);
        }
    }

    /**
     * Switch to a different tab.
     * @param {string} tabId
     */
    #switchTab(tabId) {
        if (tabId === this.#activeTabId) return;
        if (!this.#tabs.has(tabId)) return;

        // Block switching during processing
        if (this.#stateMachine.isProcessing()) return;

        // Cache current tab state
        this.#cacheActiveTabState();

        // Load target tab
        this.#activeTabId = tabId;
        const tab = this.#tabs.get(tabId);

        // Restore FSM state
        if (tab.conversationId) {
            this.#stateMachine.loadConversation(tab.conversationId);
        } else {
            this.#stateMachine.newConversation();
        }

        this.#messageBatchActions.clear();
        this.#pendingBatch = null;

        // Restore messages and rebuild batch actions from stored operations
        this.#component.restoreMessages(tab.messages);
        this.#rebuildBatchActions(tab.messages);
        this.#component.setScrollPos(tab.scrollPos);
        this.#renderTabBar();
        this.#saveTabs();

        // Reconcile with backend in case localStorage is stale
        this.#reconcileTab(tabId);
    }

    /**
     * Close a tab. Prevents closing the last tab.
     * @param {string} tabId
     */
    #closeTab(tabId) {
        if (this.#tabs.size <= 1) return;
        if (!this.#tabs.has(tabId)) return;

        // Don't close active tab while processing
        if (tabId === this.#activeTabId && this.#stateMachine.isProcessing()) return;

        this.#tabs.delete(tabId);

        if (tabId === this.#activeTabId) {
            // Switch to the next available tab
            const nextId = this.#tabs.keys().next().value;
            this.#activeTabId = nextId;
            const tab = this.#tabs.get(nextId);
            if (tab.conversationId) {
                this.#stateMachine.loadConversation(tab.conversationId);
            } else {
                this.#stateMachine.newConversation();
            }
            this.#component.restoreMessages(tab.messages);
            this.#component.setScrollPos(tab.scrollPos);
        }

        this.#renderTabBar();
        this.#saveTabs();
    }

    /**
     * Rename a tab.
     * @param {string} tabId
     * @param {string} newTitle
     */
    #renameTab(tabId, newTitle) {
        const tab = this.#tabs.get(tabId);
        if (!tab) return;
        tab.title = newTitle;
        this.#saveTabs();
    }

    /** Reset the current tab's conversation. */
    #resetTab() {
        if (this.#stateMachine.isProcessing()) return;

        const tab = this.#tabs.get(this.#activeTabId);
        if (tab) {
            tab.conversationId = null;
            tab.messages = [];
            tab.scrollPos = 0;
            tab.title = 'New chat';
        }

        this.#messageBatchActions.clear();
        this.#pendingBatch = null;
        this.#stateMachine.newConversation();
        this.#component.clearMessages();
        this.#renderTabBar();
        this.#saveTabs();
    }

    /** Cache the active tab's current messages and scroll position. */
    #cacheActiveTabState() {
        const tab = this.#tabs.get(this.#activeTabId);
        if (!tab) return;
        tab.messages = this.#component.getMessages();
        tab.scrollPos = this.#component.getScrollPos();
        tab.conversationId = this.#stateMachine.conversationId;
    }

    /** Render the tab bar via the component. */
    #renderTabBar() {
        const tabList = [];
        for (const [id, tab] of this.#tabs) {
            tabList.push({ id, title: tab.title });
        }
        this.#component.renderTabBar(tabList, this.#activeTabId);
    }

    /** Persist all tabs to localStorage. */
    #saveTabs() {
        this.#cacheActiveTabState();
        const data = {
            activeTabId: this.#activeTabId,
            tabCounter: this.#tabCounter,
            tabs: [],
        };
        for (const [id, tab] of this.#tabs) {
            data.tabs.push({
                id,
                conversationId: tab.conversationId,
                title: tab.title,
                messages: tab.messages,
            });
        }
        try {
            localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(data));
        } catch { /* quota exceeded — ignore */ }
    }

    /**
     * Restore tabs from localStorage.
     * @returns {boolean} true if tabs were restored
     */
    #restoreTabs() {
        try {
            const raw = localStorage.getItem(CHAT_STORAGE_KEY);
            if (!raw) return false;
            const data = JSON.parse(raw);
            if (!data.tabs?.length) return false;

            this.#tabCounter = data.tabCounter || 0;

            for (const t of data.tabs) {
                this.#tabs.set(t.id, {
                    conversationId: t.conversationId || null,
                    title: t.title || 'New chat',
                    messages: t.messages || [],
                    scrollPos: 0,
                });
            }

            // Activate the persisted active tab (or first available)
            const targetId = this.#tabs.has(data.activeTabId)
                ? data.activeTabId
                : this.#tabs.keys().next().value;

            this.#activeTabId = targetId;
            const tab = this.#tabs.get(targetId);
            if (tab.conversationId) {
                this.#stateMachine.loadConversation(tab.conversationId);
            }
            this.#component.restoreMessages(tab.messages);
            this.#rebuildBatchActions(tab.messages);
            this.#renderTabBar();

            // Reconcile with backend asynchronously — if a reload interrupted
            // streaming, the backend may have the completed assistant response
            // that localStorage missed.
            this.#reconcileTab(targetId);

            return true;
        } catch {
            return false;
        }
    }

    #handleNewChat() {
        this.#createTab();
    }

    // ─── Apply operations ───────────────────────────────────────────────

    #applyOperations(operations, messageId = null) {
        if (!operations?.length) return;

        // Wrap in a HistoryService batch so all ops = one undo entry
        this.#historyService?.startBatch();
        const result = this.#applier.apply(operations);
        const batchAction = this.#historyService?.endBatch();

        // Store pending batch — UI rendering deferred to #finalizeOperationControls
        // because the DOM element doesn't exist yet (addAssistantMessage hasn't run).
        this.#pendingBatch = {
            batchAction: batchAction || null,
            itemApplied: batchAction
                ? new Array((batchAction.actions || []).length).fill(true)
                : null,
            operations,
        };

        // Mark as applied in backend
        if (messageId) {
            const api = window.pywebview?.api;
            api?.ai_approve_changes?.({
                conversationId: this.#stateMachine.conversationId,
                messageId,
            });
        }
    }

    /**
     * Apply a batch of operations received incrementally during streaming.
     * The idMap persists across batches; the HistoryService batch stays open
     * until onStreamComplete finalizes it.
     */
    #applyIncrementalOperations(operations) {
        if (!operations?.length) return;

        // Start the HistoryService batch on the first incremental batch
        if (!this.#incrementalBatchStarted) {
            this.#applier.resetIdMap();
            this.#historyService?.startBatch();
            this.#incrementalBatchStarted = true;
            this.#allIncrementalOps = [];
        }

        this.#applier.applyIncremental(operations);
        this.#allIncrementalOps.push(...operations);
    }

    /**
     * Finalize operation controls after addAssistantMessage has created the DOM element.
     * Transfers pending batch data into the message map and renders individual items.
     */
    #finalizeOperationControls() {
        if (!this.#pendingBatch) return;

        const messageIndex = this.#component.getMessageCount() - 1;
        if (messageIndex < 0) {
            this.#pendingBatch = null;
            return;
        }

        const { batchAction, itemApplied, operations } = this.#pendingBatch;
        this.#pendingBatch = null;

        // Derive display items from the raw operations (stable across reload)
        const items = operations.map(op => AiProjectApplier.describeOperation(op));

        this.#messageBatchActions.set(messageIndex, {
            batchAction,
            allApplied: true,
            itemApplied,
            operations,
        });

        this.#component.setOperationDetails(messageIndex, items);
        this.#component.markOperationsApplied(messageIndex, true);

        // Persist items in the shadow message so they survive reload
        this.#component.updateMessageMeta(messageIndex, { items });
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    #serializeProject() {
        const project = this.#projectModel;
        if (!project?.isOpen) return {};

        const files = {};
        // Include all project files for full AI context
        const allPaths = [
            ...(project.namespacePaths || []),
            ...(project.modulePaths || []),
            ...(project.scenarioPaths || []),
            ...(project.dashboardPaths || []),
        ];
        for (const fp of allPaths) {
            const openFile = project.getOpenFile?.(fp);
            if (openFile?.content != null) {
                files[fp] = openFile.content;
            }
        }

        return {
            manifest: project.manifest,
            files,
            activeFilePath: project.activeFilePath,
            projectPath: project.projectPath,
        };
    }

    #getWorkspacePath() {
        return this.#projectModel?.projectPath ?? '';
    }

    #getAiSettings() {
        const provider = getSetting('ai.provider', '');
        const cloudProviderId = (provider && provider !== 'local')
            ? provider
            : getSetting('ai.cloud.providerId', 'anthropic');

        return {
            provider,
            cloud: {
                providerId: cloudProviderId,
                apiKey: getSetting(`ai.cloud.providers.${cloudProviderId}.apiKey`, ''),
                model: getSetting(`ai.cloud.providers.${cloudProviderId}.model`, ''),
                baseUrl: getSetting(`ai.cloud.providers.${cloudProviderId}.baseUrl`, ''),
            },
            local: {
                baseUrl: getSetting('ai.local.baseUrl', ''),
                model: getSetting('ai.local.model', ''),
                serverType: getSetting('ai.local.serverType', 'llamacpp'),
                modelPath: getSetting('ai.local.modelPath', ''),
                port: getSetting('ai.local.port', 8080),
                gpuLayers: getSetting('ai.local.gpuLayers', -1),
                contextLength: getSetting('ai.local.contextLength', 32768),
            },
            defaultMode: getSetting('ai.defaultMode', 'ask'),
            maxToolCalls: getSetting('ai.maxToolCalls', 25),
        };
    }
}
