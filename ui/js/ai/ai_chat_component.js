/**
 * AI Chat Component.
 *
 * Renders the chat message list, input area, mode toggle, model selector,
 * local LLM management panel, and preview panel inside the AI Assistant
 * collapsible box in the right panel.
 *
 * BEM naming: ai-chat, ai-chat__*, ai-chat__*--modifier
 *
 * @module ai/ai_chat_component
 */

import { ComponentBase } from '../ui/base/component_base.js';
import { AI_STATES, AI_BUS_EVENTS } from './ai_state_machine.js';
import { renderMarkdown } from './ai_markdown.js';
import { showConfirmDialog } from '../ui/components/confirm_dialog.js';
import { installOverlayScrollbar } from '../ui/utils/overlay_scrollbar.js';


export class AiChatComponent extends ComponentBase {

    /** @type {HTMLElement} */
    #root = null;

    /** @type {HTMLElement} */
    #messageList = null;

    /** @type {HTMLTextAreaElement} */
    #inputEl = null;

    /** @type {HTMLButtonElement} */
    #sendBtn = null;

    /** @type {HTMLButtonElement} */
    #cancelBtn = null;

    /** @type {HTMLElement} */
    #modelBtn = null;

    /** @type {HTMLElement} */
    #modelDropdown = null;

    /** @type {import('./ai_state_machine.js').AiStateMachine} */
    #stateMachine = null;

    /** @type {import('./ai_diff_renderer.js').AiDiffRenderer} */
    #diffRenderer = null;

    /** Callbacks */
    #onSend = null;
    #onCancel = null;
    #onToggleAllOperations = null;
    #onToggleOperation = null;
    #onNewChat = null;
    #onModeChange = null;
    #onModelChange = null;
    /** @type {Function} (action: string, value?: string) => void */
    #onLocalAction = null;
    #onManageServer = null;
    #onManageCloud = null;
    #onTabSwitch = null;
    #onTabClose = null;
    #onTabAdd = null;
    #onTabReset = null;
    #onTabRename = null;

    /** Shadow message array for tab switching */
    #shadowMessages = [];

    /** Disposers for event subscriptions */
    #disposers = [];

    /** Accumulated streaming text for current assistant message */
    #streamingText = '';
    #streamingEl = null;

    /** @type {HTMLButtonElement} Scroll-to-bottom FAB */
    #scrollBottomBtn = null;

    /** Overlay scrollbar handle */
    #overlayScrollbar = null;

    /** Outside-click handler reference for cleanup */
    #outsideClickHandler = null;

    /**
     * Mount the chat component into a container.
     *
     * @param {HTMLElement} container
     * @param {object} props
     * @param {import('./ai_state_machine.js').AiStateMachine} props.stateMachine
     * @param {import('./ai_diff_renderer.js').AiDiffRenderer} props.diffRenderer
     * @param {Function} props.onSend
     * @param {Function} props.onToggleAllOperations
     * @param {Function} props.onToggleOperation
     * @param {Function} props.onNewChat
     * @param {Function} props.onModeChange
     * @param {Function} props.onModelChange
     * @param {Function} props.onLocalAction
     */
    mount(container, props) {
        this.#stateMachine = props.stateMachine;
        this.#diffRenderer = props.diffRenderer;
        this.#onSend = props.onSend;
        this.#onCancel = props.onCancel;
        this.#onToggleAllOperations = props.onToggleAllOperations;
        this.#onToggleOperation = props.onToggleOperation;
        this.#onNewChat = props.onNewChat;
        this.#onModeChange = props.onModeChange;
        this.#onModelChange = props.onModelChange;
        this.#onLocalAction = props.onLocalAction;
        this.#onManageServer = props.onManageServer;
        this.#onManageCloud = props.onManageCloud;
        this.#onTabSwitch = props.onTabSwitch;
        this.#onTabClose = props.onTabClose;
        this.#onTabAdd = props.onTabAdd;
        this.#onTabReset = props.onTabReset;
        this.#onTabRename = props.onTabRename;

        this.#root = document.createElement('div');
        this.#root.className = 'ai-chat';

        this.#root.innerHTML = this.#template();
        container.appendChild(this.#root);

        this.#messageList = this.#root.querySelector('.ai-chat__messages');
        this.#inputEl = this.#root.querySelector('.ai-chat__input');
        this.#sendBtn = this.#root.querySelector('.ai-chat__send-btn');
        this.#cancelBtn = this.#root.querySelector('.ai-chat__cancel-btn');
        this.#modelBtn = this.#root.querySelector('.ai-chat__model-btn');
        this.#modelDropdown = this.#root.querySelector('.ai-chat__model-dropdown');

        this.#bindEvents();
        this.#subscribeToEvents();
        this.#createScrollBottomButton();
        this.#overlayScrollbar = installOverlayScrollbar(this.#messageList, {
            orientation: 'vertical',
            setOverflow: false,
            setPosition: false,
        });
        this.#updateState();

        this._mounted = true;
    }

    dispose() {
        if (this.#outsideClickHandler) {
            document.removeEventListener('pointerdown', this.#outsideClickHandler, true);
            this.#outsideClickHandler = null;
        }
        this.#overlayScrollbar?.cleanup?.();
        this.#overlayScrollbar = null;
        for (const d of this.#disposers) {
            d?.dispose?.();
        }
        this.#disposers = [];
        if (this.#root?.parentNode) {
            this.#root.parentNode.removeChild(this.#root);
        }
        this.#root = null;
        this._mounted = false;
    }

    // ─── Public API ─────────────────────────────────────────────────────

    addUserMessage(text) {
        this.#appendMessage('user', text);
        this.#shadowMessages.push({ role: 'user', content: text });
    }

    addAssistantMessage(text, operations = null, dslDiff = null) {
        // Remove typing indicator if present
        this.#removeTypingIndicator();

        // If streaming element exists, finalize it (message is already rendered)
        let wasStreaming = false;
        if (this.#streamingEl) {
            wasStreaming = true;
            this.#streamingEl.classList.remove('ai-chat__message--streaming');
            // Add copy button and timestamp on finalization
            this.#addCopyButton(this.#streamingEl, text || this.#streamingText);
            this.#addTimestamp(this.#streamingEl);
            this.#streamingEl = null;
            this.#streamingText = '';
        }

        // Only append a new message if streaming didn't already render it
        if (!wasStreaming) {
            this.#appendMessage('assistant', text);
        }

        // Show operation controls if present
        if (operations?.length > 0) {
            this.#appendOperationControls(operations, this.#shadowMessages.length);
        }

        this.#shadowMessages.push({ role: 'assistant', content: text, operations, dslDiff });
    }

    clearMessages() {
        if (this.#messageList) {
            this.#messageList.innerHTML = '';
            // Re-append overlay scrollbar and scroll-to-bottom button (removed by innerHTML)
            if (this.#overlayScrollbar?.bar) {
                this.#messageList.appendChild(this.#overlayScrollbar.bar);
            }
            if (this.#scrollBottomBtn) {
                this.#messageList.appendChild(this.#scrollBottomBtn);
            }
        }
        this.#streamingText = '';
        this.#streamingEl = null;
        this.#shadowMessages = [];
    }

    /** Get the current shadow message array for tab state caching. */
    getMessages() {
        return [...this.#shadowMessages];
    }

    /** Get the count of shadow messages. */
    getMessageCount() {
        return this.#shadowMessages.length;
    }

    /**
     * Patch metadata on a shadow message (e.g. to persist derived items).
     * @param {number} index
     * @param {object} patch
     */
    updateMessageMeta(index, patch) {
        if (index >= 0 && index < this.#shadowMessages.length) {
            Object.assign(this.#shadowMessages[index], patch);
        }
    }

    /**
     * Update the operation controls for a message to show applied/unapplied state.
     * @param {number} messageIndex
     * @param {boolean} applied
     */
    markOperationsApplied(messageIndex, applied) {
        const el = this.#messageList?.querySelector(
            `.ai-chat__message--operations[data-message-index="${messageIndex}"]`
        );
        if (!el) return;

        const dot = el.querySelector('.ai-chat__ops-dot');
        const text = el.querySelector('.ai-chat__ops-text');
        const btn = el.querySelector('.ai-chat__ops-toggle');

        if (dot) {
            dot.className = applied
                ? 'ai-chat__ops-dot ai-chat__ops-dot--applied'
                : 'ai-chat__ops-dot ai-chat__ops-dot--unapplied';
        }
        if (text) {
            const existing = text.textContent;
            const colonIdx = existing.indexOf(':');
            const desc = colonIdx >= 0 ? existing.slice(colonIdx) : '';
            text.textContent = `${applied ? 'Applied' : 'Unapplied'}${desc}`;
        }
        if (btn) {
            btn.textContent = applied ? 'Unapply' : 'Apply';
            btn.title = applied ? 'Revert these changes' : 'Re-apply these changes';
        }
    }

    /**
     * Render the list of individual operations for a message.
     * Each item shows an icon, label, and per-item toggle button.
     * @param {number} messageIndex
     * @param {Array<{label: string, iconClass: string}>} items
     */
    setOperationDetails(messageIndex, items) {
        const el = this.#messageList?.querySelector(
            `.ai-chat__message--operations[data-message-index="${messageIndex}"]`
        );
        if (!el || !items?.length) return;

        // Remove existing details if any
        el.querySelector('.ai-chat__ops-details')?.remove();

        const details = document.createElement('div');
        details.className = 'ai-chat__ops-details';

        items.forEach((item, actionIndex) => {
            const row = document.createElement('div');
            row.className = 'ai-chat__ops-item';
            row.dataset.actionIndex = actionIndex;

            const icon = document.createElement('span');
            icon.className = `ai-chat__ops-item-icon ai-chat__ops-item-icon--${item.iconClass}`;
            const iconChar = item.iconClass === 'add' ? '+' : item.iconClass === 'remove' ? '\u2212' : '~';
            icon.textContent = iconChar;

            const label = document.createElement('span');
            label.className = 'ai-chat__ops-item-label';
            label.textContent = item.label;

            const toggle = document.createElement('button');
            toggle.className = 'ai-chat__ops-item-toggle';
            toggle.textContent = 'Undo';
            toggle.title = 'Undo this change';
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.#onToggleOperation?.(messageIndex, actionIndex);
            });

            row.appendChild(icon);
            row.appendChild(label);
            row.appendChild(toggle);
            details.appendChild(row);
        });

        el.appendChild(details);
        this.#scrollToBottom();
    }

    /**
     * Update the visual state of a single operation item.
     * @param {number} messageIndex
     * @param {number} actionIndex
     * @param {boolean} applied
     */
    markItemApplied(messageIndex, actionIndex, applied) {
        const el = this.#messageList?.querySelector(
            `.ai-chat__message--operations[data-message-index="${messageIndex}"]`
        );
        if (!el) return;

        const item = el.querySelector(`.ai-chat__ops-item[data-action-index="${actionIndex}"]`);
        if (!item) return;

        item.classList.toggle('ai-chat__ops-item--unapplied', !applied);

        const toggle = item.querySelector('.ai-chat__ops-item-toggle');
        if (toggle) {
            toggle.textContent = applied ? 'Undo' : 'Redo';
            toggle.title = applied ? 'Undo this change' : 'Redo this change';
        }
    }

    /**
     * Update the visual state of all operation items in a message.
     * @param {number} messageIndex
     * @param {boolean} applied
     */
    markAllItems(messageIndex, applied) {
        const el = this.#messageList?.querySelector(
            `.ai-chat__message--operations[data-message-index="${messageIndex}"]`
        );
        if (!el) return;

        el.querySelectorAll('.ai-chat__ops-item').forEach(item => {
            item.classList.toggle('ai-chat__ops-item--unapplied', !applied);
            const toggle = item.querySelector('.ai-chat__ops-item-toggle');
            if (toggle) {
                toggle.textContent = applied ? 'Undo' : 'Redo';
                toggle.title = applied ? 'Undo this change' : 'Redo this change';
            }
        });
    }

    /**
     * Restore messages from a cached array (for tab switching).
     * @param {Array<{role: string, content: string, operations?: Array, dslDiff?: string}>} messages
     */
    restoreMessages(messages) {
        this.clearMessages();
        if (!messages?.length) return;

        // Remove welcome message
        const welcome = this.#messageList?.querySelector('.ai-chat__welcome');
        if (welcome) welcome.remove();

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.role === 'user') {
                this.#appendMessage('user', msg.content);
            } else if (msg.role === 'assistant') {
                this.#appendMessage('assistant', msg.content);
                if (msg.operations?.length > 0) {
                    // Render interactive controls (with master toggle)
                    this.#appendOperationControls(msg.operations, i);
                    // Restore individual items if persisted
                    if (msg.items?.length > 0) {
                        this.setOperationDetails(i, msg.items);
                    }
                }
            } else if (msg.role === 'error') {
                this.#appendMessage('error', msg.content);
            }
        }
        this.#shadowMessages = [...messages];
    }

    /**
     * Render the tab bar with given tab list.
     * @param {Array<{id: string, title: string}>} tabs
     * @param {string} activeId
     */
    renderTabBar(tabs, activeId) {
        const container = this.#root?.querySelector('.tabs');
        const addBtn = container?.querySelector('.ai-chat__tab-add-btn');
        if (!container || !addBtn) return;

        // Remove existing tab elements
        container.querySelectorAll('.tab').forEach(el => el.remove());

        for (const tab of tabs) {
            const el = document.createElement('div');
            el.className = 'tab';
            if (tab.id === activeId) el.classList.add('active');
            el.dataset.tabId = tab.id;

            const title = document.createElement('span');
            title.className = 'tab-title';
            title.textContent = tab.title;
            el.appendChild(title);

            if (tabs.length > 1) {
                const closeBtn = document.createElement('button');
                closeBtn.className = 'tab-close';
                closeBtn.textContent = '\u00d7';
                closeBtn.setAttribute('aria-label', 'Close tab');
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.#onTabClose?.(tab.id);
                });
                el.appendChild(closeBtn);
            }

            el.addEventListener('click', () => {
                if (tab.id !== activeId) {
                    this.#onTabSwitch?.(tab.id);
                }
            });

            title.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.#beginInlineRename(tab.id, title);
            });

            container.insertBefore(el, addBtn);
        }
    }

    /**
     * Start inline rename on a tab title element.
     * @param {string} tabId
     * @param {HTMLElement} titleEl
     */
    #beginInlineRename(tabId, titleEl) {
        if (titleEl.isContentEditable) return;

        const original = titleEl.textContent || '';
        titleEl.setAttribute('contenteditable', 'true');
        titleEl.focus();

        // Select all text
        const range = document.createRange();
        range.selectNodeContents(titleEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        const finish = (commit) => {
            titleEl.removeAttribute('contenteditable');
            titleEl.removeEventListener('keydown', onKeyDown);
            titleEl.removeEventListener('blur', onBlur);

            const raw = (titleEl.textContent || '').trim();
            if (commit && raw && raw !== original) {
                titleEl.textContent = raw;
                this.#onTabRename?.(tabId, raw);
            } else {
                titleEl.textContent = original;
            }
        };

        const onKeyDown = (ev) => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                finish(true);
            } else if (ev.key === 'Escape') {
                ev.preventDefault();
                finish(false);
            }
        };

        const onBlur = () => finish(true);

        titleEl.addEventListener('keydown', onKeyDown);
        titleEl.addEventListener('blur', onBlur);
    }

    /** Get current scroll position for tab state caching. */
    getScrollPos() {
        return this.#messageList?.scrollTop || 0;
    }

    /** Restore scroll position after tab switch. */
    setScrollPos(pos) {
        if (this.#messageList) {
            this.#messageList.scrollTop = pos;
        }
    }

    /**
     * Update the model button label to show the current active model.
     * @param {string} displayName
     */
    updateModelDisplay(displayName) {
        const label = this.#root?.querySelector('.ai-chat__model-btn-label');
        if (label) {
            label.textContent = displayName;
        }
    }

    /**
     * Highlight the active model in the dropdown.
     * @param {'anthropic'|'local'} provider
     * @param {string} modelId
     */
    setActiveModel(provider, modelId) {
        if (!this.#modelDropdown) return;

        this.#modelDropdown.querySelectorAll('.ai-chat__model-option').forEach(opt => {
            const isMatch = opt.dataset.provider === provider && opt.dataset.model === modelId;
            opt.classList.toggle('ai-chat__model-option--active', isMatch);
            const check = opt.querySelector('.ai-chat__model-option-check');
            if (check) check.textContent = isMatch ? '\u2713' : '';
        });
    }

    /**
     * Update cloud model options in the dropdown.
     * @param {Array<{id: string, name: string}>} models
     * @param {string} providerId - Cloud provider ID (e.g. 'anthropic', 'openai')
     */
    updateCloudModels(models, providerId) {
        const container = this.#modelDropdown?.querySelector('.ai-chat__model-cloud-options');
        if (!container) return;
        container.innerHTML = '';

        for (const m of models) {
            const opt = document.createElement('div');
            opt.className = 'ai-chat__model-option';
            opt.dataset.provider = providerId;
            opt.dataset.model = m.id;
            opt.innerHTML = `
                <span class="ai-chat__model-option-check"></span>
                <span class="ai-chat__model-option-name">${m.name}</span>
            `;
            container.appendChild(opt);
        }
    }

    /**
     * Update local LLM status displays (dropdown + management panel).
     * @param {object} status
     * @param {string} status.status - stopped|starting|running|error|connected
     * @param {string} [status.serverType]
     * @param {string} [status.modelPath]
     * @param {string} [status.error]
     * @param {object} [status.backends] - {llamacpp, ollama, vllm, ...}
     * @param {Array} [status.ollamaModels] - [{name, size}]
     * @param {string} [status.externalUrl]
     */
    updateLocalStatus(status) {
        this.#updateDropdownLocalStatus(status);
    }

    // ─── Template ───────────────────────────────────────────────────────

    #template() {
        return `
            <div class="tabs">
                <div class="add-tab ai-chat__tab-add-btn" title="New tab">
                    <span class="material-symbols-outlined">add</span>
                </div>
                <div class="add-tab ai-chat__tab-clear-btn" title="Clear conversation">
                    <span class="material-symbols-outlined">delete_sweep</span>
                </div>
            </div>
            <div class="ai-chat__messages">
                <div class="ai-chat__welcome">
                    <span class="material-symbols-outlined ai-chat__welcome-icon">smart_toy</span>
                    <p>Describe what you want to build or change and the AI assistant will modify your model.</p>
                </div>
            </div>
            <div class="ai-chat__input-area">
                <textarea class="ai-chat__input" placeholder="Describe model changes..." rows="2"></textarea>
            </div>
            <div class="ai-chat__action-bar">
                <div class="ai-chat__mode-toggle">
                    <button class="ai-chat__mode-btn ai-chat__mode-btn--active" data-mode="ask">Ask</button>
                    <button class="ai-chat__mode-btn" data-mode="edit">Edit</button>
                </div>
                <div class="ai-chat__action-bar-spacer"></div>
                <div class="ai-chat__model-selector">
                    <button class="ai-chat__model-btn">
                        <span class="ai-chat__model-btn-label">Select model...</span>
                        <span class="material-symbols-outlined ai-chat__model-chevron">expand_more</span>
                    </button>
                    <div class="ai-chat__model-dropdown">
                        <div class="ai-chat__model-group">
                            <div class="ai-chat__model-group-label">Cloud</div>
                            <div class="ai-chat__model-cloud-options"></div>
                            <div class="ai-chat__model-local-action" data-action="configure-cloud">
                                Configure cloud...
                            </div>
                        </div>
                        <div class="ai-chat__model-group">
                            <div class="ai-chat__model-group-label">Local</div>
                            <div class="ai-chat__model-local-status">
                                <span class="ai-chat__model-local-dot"></span>
                                <span class="ai-chat__model-local-status-text">Stopped</span>
                            </div>
                            <div class="ai-chat__model-option" data-provider="local" data-model="local">
                                <span class="ai-chat__model-option-check"></span>
                                <span class="ai-chat__model-option-name">Use local model</span>
                            </div>
                            <div class="ai-chat__model-local-action" data-action="manage">
                                Manage server...
                            </div>
                        </div>
                    </div>
                </div>
                <button class="ai-chat__send-btn" title="Send message">
                    <span class="material-symbols-outlined">send</span>
                </button>
                <button class="ai-chat__cancel-btn" title="Cancel" style="display:none">
                    <span class="material-symbols-outlined">stop</span>
                </button>
            </div>
        `;
    }

    // ─── DOM Events ─────────────────────────────────────────────────────

    #bindEvents() {
        // Send button
        this.#sendBtn.addEventListener('click', () => this.#doSend());

        // Cancel button
        this.#cancelBtn.addEventListener('click', () => this.#onCancel?.());

        // Enter to send (Shift+Enter for newline), Escape to cancel
        this.#inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.#doSend();
            } else if (e.key === 'Escape') {
                this.#onCancel?.();
            }
        });

        // Auto-resize textarea
        this.#inputEl.addEventListener('input', () => {
            this.#inputEl.style.height = 'auto';
            this.#inputEl.style.height = Math.min(this.#inputEl.scrollHeight, 120) + 'px';
        });

        // Mode toggle
        this.#root.querySelectorAll('.ai-chat__mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                this.#root.querySelectorAll('.ai-chat__mode-btn').forEach(b =>
                    b.classList.toggle('ai-chat__mode-btn--active', b === btn)
                );
                this.#onModeChange?.(mode);
            });
        });

        // Tab add button
        this.#root.querySelector('.ai-chat__tab-add-btn')?.addEventListener('click', () => {
            this.#onTabAdd?.();
        });

        // Tab clear button
        this.#root.querySelector('.ai-chat__tab-clear-btn')?.addEventListener('click', async () => {
            if (this.#shadowMessages.length === 0) {
                this.#onTabReset?.();
                return;
            }
            const confirmed = await showConfirmDialog({
                title: 'Clear Conversation',
                message: 'Clear this conversation? This cannot be undone.',
                icon: 'delete_sweep',
                okLabel: 'Clear',
                cancelLabel: 'Cancel',
                okVariant: 'danger',
            });
            if (confirmed) {
                this.#onTabReset?.();
            }
        });

        // Model selector toggle
        this.#modelBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.#toggleModelDropdown();
        });

        // Model option selection (delegated — cloud options are added dynamically)
        this.#modelDropdown?.addEventListener('click', (e) => {
            const opt = e.target.closest('.ai-chat__model-option');
            if (opt) {
                this.#onModelChange?.({ provider: opt.dataset.provider, model: opt.dataset.model });
                this.#closeModelDropdown();
                return;
            }
            const action = e.target.closest('.ai-chat__model-local-action');
            if (action?.dataset.action === 'manage') {
                this.#closeModelDropdown();
                this.#onManageServer?.();
            } else if (action?.dataset.action === 'configure-cloud') {
                this.#closeModelDropdown();
                this.#onManageCloud?.();
            }
        });

        // Outside click to close dropdowns
        this.#outsideClickHandler = (e) => {
            // Close model dropdown
            if (this.#modelDropdown?.classList.contains('ai-chat__model-dropdown--open')) {
                const selector = this.#root?.querySelector('.ai-chat__model-selector');
                if (selector && !selector.contains(e.target)) {
                    this.#closeModelDropdown();
                }
            }
        };
        document.addEventListener('pointerdown', this.#outsideClickHandler, true);

    }

    // ─── Model Dropdown ─────────────────────────────────────────────────

    #toggleModelDropdown() {
        const isOpen = this.#modelDropdown?.classList.contains('ai-chat__model-dropdown--open');
        if (isOpen) {
            this.#closeModelDropdown();
        } else {
            this.#modelDropdown?.classList.add('ai-chat__model-dropdown--open');
            this.#modelBtn?.classList.add('ai-chat__model-btn--open');
            this.#positionModelDropdown();
        }
    }

    #positionModelDropdown() {
        if (!this.#modelDropdown || !this.#modelBtn) return;
        const rect = this.#modelBtn.getBoundingClientRect();
        this.#modelDropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
        this.#modelDropdown.style.right = `${window.innerWidth - rect.right}px`;
    }

    #closeModelDropdown() {
        this.#modelDropdown?.classList.remove('ai-chat__model-dropdown--open');
        this.#modelBtn?.classList.remove('ai-chat__model-btn--open');
    }

    #updateDropdownLocalStatus(status) {
        if (!this.#modelDropdown) return;

        const dot = this.#modelDropdown.querySelector('.ai-chat__model-local-dot');
        const text = this.#modelDropdown.querySelector('.ai-chat__model-local-status-text');
        const isReady = status.status === 'running' || status.status === 'connected';

        if (dot) {
            dot.className = 'ai-chat__model-local-dot';
            if (isReady) dot.classList.add('ai-chat__model-local-dot--running');
            else if (status.status === 'starting') dot.classList.add('ai-chat__model-local-dot--starting');
            else if (status.status === 'error') dot.classList.add('ai-chat__model-local-dot--error');
        }

        if (text) {
            const labels = {
                stopped: 'Stopped', starting: 'Starting...', running: 'Running',
                error: 'Error', connected: 'Connected',
            };
            text.textContent = labels[status.status] || status.status;
        }

        // Show/hide "Use local model" option based on status (like cloud mode)
        const localOpt = this.#modelDropdown.querySelector('[data-provider="local"]');
        if (localOpt) {
            localOpt.style.display = isReady ? '' : 'none';
        }
    }

    // ─── EventBus subscriptions ─────────────────────────────────────────

    #subscribeToEvents() {
        const eventBus = this.eventBus;

        // State changes
        const d1 = eventBus.on(AI_BUS_EVENTS.STATE_CHANGED, () => this.#updateState());
        this.#disposers.push(d1);

        // Streaming chunks
        const d2 = eventBus.on(AI_BUS_EVENTS.STREAM_CHUNK, ({ chunk }) => {
            this.#onStreamChunk(chunk);
        });
        this.#disposers.push(d2);

        // Error
        const d3 = eventBus.on(AI_BUS_EVENTS.ERROR, ({ message }) => {
            this.#appendMessage('error', message);
        });
        this.#disposers.push(d3);

        // Mode change
        const d4 = eventBus.on(AI_BUS_EVENTS.MODE_CHANGED, ({ mode }) => {
            this.#root?.querySelectorAll('.ai-chat__mode-btn').forEach(btn => {
                btn.classList.toggle('ai-chat__mode-btn--active', btn.dataset.mode === mode);
            });
        });
        this.#disposers.push(d4);
    }

    // ─── Send ───────────────────────────────────────────────────────────

    #doSend() {
        const text = this.#inputEl?.value?.trim();
        if (!text) return;

        // Reset input BEFORE appending the message so the messages area has
        // its full height when scrollToBottom runs inside addUserMessage.
        this.#inputEl.value = '';
        this.#inputEl.style.height = 'auto';

        // Remove welcome message if present
        const welcome = this.#messageList?.querySelector('.ai-chat__welcome');
        if (welcome) welcome.remove();

        this.addUserMessage(text);
        this.#onSend?.(text);
    }

    // ─── Streaming ──────────────────────────────────────────────────────

    #onStreamChunk(chunk) {
        if (!this.#streamingEl) {
            // Remove typing indicator — real content is arriving
            this.#removeTypingIndicator();

            // Create a new streaming message element
            this.#streamingEl = document.createElement('div');
            this.#streamingEl.className = 'ai-chat__message ai-chat__message--assistant ai-chat__message--streaming';
            const contentEl = document.createElement('div');
            contentEl.className = 'ai-chat__message-content';
            this.#streamingEl.appendChild(contentEl);
            this.#messageList?.appendChild(this.#streamingEl);
            this.#streamingText = '';
        }

        this.#streamingText += chunk;
        const contentEl = this.#streamingEl.querySelector('.ai-chat__message-content');
        if (contentEl) {
            contentEl.innerHTML = renderMarkdown(this.#streamingText);
        }

        this.#scrollToBottom();
    }

    // ─── Messages ───────────────────────────────────────────────────────

    #appendMessage(role, text) {
        if (!this.#messageList || !text) return;

        const msg = document.createElement('div');
        msg.className = `ai-chat__message ai-chat__message--${role}`;

        const content = document.createElement('div');
        content.className = 'ai-chat__message-content';

        if (role === 'assistant') {
            content.innerHTML = renderMarkdown(text);
        } else {
            content.textContent = text;
        }

        msg.appendChild(content);

        // Copy button
        this.#addCopyButton(msg, text);

        // Timestamp
        this.#addTimestamp(msg);

        this.#messageList.appendChild(msg);
        this.#scrollToBottom();
    }

    /**
     * Build a human-readable description of operation counts.
     * @param {Array} operations
     * @returns {string}
     */
    #describeOperations(operations) {
        const counts = {};
        for (const op of operations) {
            const type = op.type || 'unknown';
            counts[type] = (counts[type] || 0) + 1;
        }
        return Object.entries(counts).map(([type, count]) => {
            const label = type.replace(/_/g, ' ');
            return `${count} ${label}${count > 1 ? 's' : ''}`;
        }).join(', ');
    }

    /**
     * Append interactive operation controls with apply/unapply toggle.
     * @param {Array} operations
     * @param {number} messageIndex
     */
    #appendOperationControls(operations, messageIndex) {
        if (!this.#messageList || !operations?.length) return;

        const summary = document.createElement('div');
        summary.className = 'ai-chat__message ai-chat__message--operations';
        summary.dataset.messageIndex = messageIndex;

        const desc = this.#describeOperations(operations);

        const statusRow = document.createElement('div');
        statusRow.className = 'ai-chat__ops-status-row';

        const dot = document.createElement('span');
        dot.className = 'ai-chat__ops-dot ai-chat__ops-dot--applied';

        const text = document.createElement('span');
        text.className = 'ai-chat__ops-text';
        text.textContent = `Applied: ${desc}`;

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'ai-chat__ops-toggle';
        toggleBtn.textContent = 'Unapply';
        toggleBtn.title = 'Revert these changes';
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.#onToggleAllOperations?.(messageIndex);
        });

        statusRow.appendChild(dot);
        statusRow.appendChild(text);
        statusRow.appendChild(toggleBtn);
        summary.appendChild(statusRow);

        this.#messageList.appendChild(summary);
        this.#scrollToBottom();
    }

    // ─── State updates ──────────────────────────────────────────────────

    #updateState() {
        const state = this.#stateMachine?.getState();
        if (!this.#root) return;

        // Update send button state
        const canSend = this.#stateMachine?.canSend();
        const isProcessing = this.#stateMachine?.isProcessing();

        if (this.#sendBtn) {
            this.#sendBtn.disabled = !canSend;
            this.#sendBtn.style.display = isProcessing ? 'none' : '';
        }
        if (this.#cancelBtn) {
            this.#cancelBtn.style.display = isProcessing ? '' : 'none';
        }
        if (this.#inputEl) {
            this.#inputEl.disabled = isProcessing;
        }

        // Show typing indicator when waiting (before any stream chunks arrive)
        if (isProcessing && !this.#streamingEl) {
            this.#showTypingIndicator();
        }
        if (!isProcessing) {
            this.#removeTypingIndicator();
            // Clean up stale streaming element left by error/cancel so the
            // next response creates a fresh element after the new user message
            if (this.#streamingEl) {
                this.#streamingEl.classList.remove('ai-chat__message--streaming');
                this.#streamingEl = null;
                this.#streamingText = '';
            }
        }
    }

    #showTypingIndicator() {
        if (this.#messageList?.querySelector('.ai-chat__typing')) return;
        const el = document.createElement('div');
        el.className = 'ai-chat__typing';
        el.innerHTML = '<span></span><span></span><span></span>';
        this.#messageList?.appendChild(el);
        this.#scrollToBottom();
    }

    #removeTypingIndicator() {
        this.#messageList?.querySelector('.ai-chat__typing')?.remove();
    }

    // ─── Copy button ─────────────────────────────────────────────────────

    /**
     * Add a copy-to-clipboard button to a message element.
     * @param {HTMLElement} msgEl - The .ai-chat__message element
     * @param {string} rawText - Plain text to copy
     */
    #addCopyButton(msgEl, rawText) {
        const btn = document.createElement('button');
        btn.className = 'ai-chat__copy-btn';
        btn.title = 'Copy';
        btn.innerHTML = '<span class="material-symbols-outlined">content_copy</span>';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(rawText).then(() => {
                btn.classList.add('ai-chat__copy-btn--done');
                btn.querySelector('.material-symbols-outlined').textContent = 'check';
                setTimeout(() => {
                    btn.classList.remove('ai-chat__copy-btn--done');
                    btn.querySelector('.material-symbols-outlined').textContent = 'content_copy';
                }, 1500);
            });
        });
        msgEl.appendChild(btn);
    }

    // ─── Timestamp ──────────────────────────────────────────────────────

    /**
     * Add a subtle timestamp to a message element.
     * @param {HTMLElement} msgEl
     */
    #addTimestamp(msgEl) {
        const ts = document.createElement('div');
        ts.className = 'ai-chat__message-time';
        const now = new Date();
        ts.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        msgEl.appendChild(ts);
    }

    // ─── Scroll-to-bottom ───────────────────────────────────────────────

    #createScrollBottomButton() {
        this.#scrollBottomBtn = document.createElement('button');
        this.#scrollBottomBtn.className = 'ai-chat__scroll-bottom';
        this.#scrollBottomBtn.title = 'Scroll to bottom';
        this.#scrollBottomBtn.innerHTML = '<span class="material-symbols-outlined">keyboard_arrow_down</span>';
        this.#scrollBottomBtn.addEventListener('click', () => this.#scrollToBottom());
        this.#messageList?.appendChild(this.#scrollBottomBtn);

        this.#messageList?.addEventListener('scroll', () => this.#updateScrollBottomVisibility());
    }

    #updateScrollBottomVisibility() {
        if (!this.#messageList || !this.#scrollBottomBtn) return;
        const { scrollTop, scrollHeight, clientHeight } = this.#messageList;
        const isNearBottom = scrollHeight - scrollTop - clientHeight < 60;
        this.#scrollBottomBtn.classList.toggle('ai-chat__scroll-bottom--visible', !isNearBottom);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    #scrollToBottom() {
        if (this.#messageList) {
            this.#messageList.scrollTop = this.#messageList.scrollHeight;
        }
    }

}
