/**
 * Steady State Configuration Modal Component
 *
 * Simple modal for selecting which namespace to analyze for steady state.
 * Shows a dropdown defaulting to the currently active namespace.
 */

import { ManagedWindow } from './managed_window.js';

let _window = null;
let _lastNamespaceId = null;

/**
 * Open the steady state configuration modal.
 * @param {Object} options
 * @param {Array<{id: string, label: string}>} options.namespaces - Available namespaces
 * @param {string} options.activeNamespaceId - Currently active namespace (default selection)
 * @param {Function} options.onRun - Callback when "Run" is clicked: (namespaceId) => void
 * @param {Function} options.onCancel - Callback when cancelled
 */
export function openSteadyStateConfigModal(options = {}) {
    // If already open, bring to front
    if (_window?.isVisible) {
        _window.bringToFront();
        return;
    }

    const namespaces = options.namespaces || [];
    // Prefer remembered selection, fall back to active namespace
    const remembered = _lastNamespaceId && namespaces.some(ns => (ns.id || ns) === _lastNamespaceId);
    const activeNamespaceId = remembered ? _lastNamespaceId : (options.activeNamespaceId || namespaces[0]?.id || null);
    const onRun = options.onRun || (() => {});
    const onCancel = options.onCancel || (() => {});

    // Build content
    const content = document.createElement('div');
    content.className = 'steady-state-config-modal';
    content.innerHTML = buildContent(namespaces, activeNamespaceId);

    // Wire up handlers
    wireHandlers(content, onRun, onCancel, close);

    // Clear any saved position state so modal is always centered
    try {
        const storageKey = 'ecosim.managedWindows.v1';
        const raw = localStorage.getItem(storageKey);
        if (raw) {
            const state = JSON.parse(raw);
            delete state['steady-state-config-modal'];
            localStorage.setItem(storageKey, JSON.stringify(state));
        }
    } catch (_) {}

    // Create window
    _window = new ManagedWindow({
        id: 'steady-state-config-modal',
        title: 'Steady State Analysis',
        icon: 'target',
        content,
        minWidth: 400,
        minHeight: 280,
        defaultWidth: 450,
        defaultHeight: 300,
        canMinimize: true,
        canMaximize: false,
        canResize: false,
        canDrag: true,
        modal: false,
        onClose: () => {
            _window = null;
        },
    });

    _window.show();

    // Focus the dropdown after showing
    setTimeout(() => {
        const select = content.querySelector('.steady-state-config-modal__select');
        if (select) select.focus();
    }, 50);

    function close() {
        if (_window) {
            _window.close();
            _window = null;
        }
    }
}

/**
 * Build the modal content HTML
 */
function buildContent(namespaces, activeNamespaceId) {
    const hasNamespaces = namespaces && namespaces.length > 0;

    if (!hasNamespaces) {
        return `
            <div class="steady-state-config-modal__body">
                <div class="steady-state-config-modal__empty">
                    <span class="material-symbols-outlined">info</span>
                    <p>No namespaces available. Create tabs in the model first.</p>
                </div>
            </div>
            <div class="steady-state-config-modal__footer">
                <button type="button" class="steady-state-config-modal__btn steady-state-config-modal__btn--cancel">Close</button>
            </div>
        `;
    }

    const options = namespaces.map(ns => {
        const nsId = ns.id || ns;
        const nsLabel = ns.label || ns.displayName || nsId;
        const selected = nsId === activeNamespaceId ? 'selected' : '';
        return `<option value="${escapeHtml(nsId)}" ${selected}>${escapeHtml(nsLabel)}</option>`;
    }).join('');

    return `
        <div class="steady-state-config-modal__body">
            <div class="steady-state-config-modal__description">
                <span class="material-symbols-outlined">info</span>
                <p>Find the equilibrium point where all stock derivatives equal zero.</p>
            </div>
            <div class="steady-state-config-modal__field">
                <label class="steady-state-config-modal__label">Namespace to Analyze</label>
                <select class="steady-state-config-modal__select">
                    ${options}
                </select>
            </div>
        </div>
        <div class="steady-state-config-modal__footer">
            <button type="button" class="steady-state-config-modal__btn steady-state-config-modal__btn--cancel">Cancel</button>
            <button type="button" class="steady-state-config-modal__btn steady-state-config-modal__btn--run">
                <span class="material-symbols-outlined">play_arrow</span>
                Run Analysis
            </button>
        </div>
    `;
}

/**
 * Wire up event handlers
 */
function wireHandlers(content, onRun, onCancel, close) {
    const cancelBtn = content.querySelector('.steady-state-config-modal__btn--cancel');
    const runBtn = content.querySelector('.steady-state-config-modal__btn--run');
    const select = content.querySelector('.steady-state-config-modal__select');

    const handleRun = () => {
        const selectedNamespaceId = select?.value || null;
        _lastNamespaceId = selectedNamespaceId;
        close();
        onRun(selectedNamespaceId);
    };

    const handleCancel = () => {
        close();
        onCancel();
    };

    if (cancelBtn) {
        cancelBtn.addEventListener('click', handleCancel);
    }

    if (runBtn) {
        runBtn.addEventListener('click', handleRun);
    }

    // Keyboard shortcuts
    content.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleRun();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            handleCancel();
        }
    });
}

/**
 * Escape HTML entities
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Close the modal if open
 */
export function closeSteadyStateConfigModal() {
    if (_window) {
        _window.close();
        _window = null;
    }
}

export default { open: openSteadyStateConfigModal, close: closeSteadyStateConfigModal };
