/**
 * AI DSL Diff Renderer.
 *
 * Renders a unified diff of EcoLang DSL before/after AI changes.
 * Added lines are highlighted green, removed lines red.
 * Context lines are shown with muted styling.
 *
 * @module ai/ai_diff_renderer
 */

export class AiDiffRenderer {

    /** @type {HTMLElement|null} */
    #container = null;

    /**
     * Mount the diff renderer into a container element.
     *
     * @param {HTMLElement} container
     */
    mount(container) {
        this.#container = container;
    }

    /**
     * Render a unified diff string into the container.
     *
     * @param {string} diffText - Unified diff output (from Python difflib)
     */
    render(diffText) {
        if (!this.#container) return;
        this.#container.innerHTML = '';

        if (!diffText || !diffText.trim()) {
            this.#container.innerHTML = '<div class="ai-diff__empty">No changes</div>';
            return;
        }

        const pre = document.createElement('pre');
        pre.className = 'ai-diff__content';

        const lines = diffText.split('\n');
        for (const line of lines) {
            const lineEl = document.createElement('div');
            lineEl.className = 'ai-diff__line';

            if (line.startsWith('+++') || line.startsWith('---')) {
                lineEl.classList.add('ai-diff__line--header');
            } else if (line.startsWith('@@')) {
                lineEl.classList.add('ai-diff__line--hunk');
            } else if (line.startsWith('+')) {
                lineEl.classList.add('ai-diff__line--added');
            } else if (line.startsWith('-')) {
                lineEl.classList.add('ai-diff__line--removed');
            } else {
                lineEl.classList.add('ai-diff__line--context');
            }

            lineEl.textContent = line;
            pre.appendChild(lineEl);
        }

        this.#container.appendChild(pre);
    }

    /**
     * Render an operation list as a human-readable summary.
     *
     * @param {Array<{type: string, params: object}>} operations
     */
    renderOperationList(operations) {
        if (!this.#container) return;
        this.#container.innerHTML = '';

        if (!operations?.length) {
            this.#container.innerHTML = '<div class="ai-diff__empty">No operations</div>';
            return;
        }

        const list = document.createElement('ul');
        list.className = 'ai-diff__op-list';

        for (const op of operations) {
            const li = document.createElement('li');
            li.className = 'ai-diff__op-item';

            const icon = document.createElement('span');
            icon.className = 'ai-diff__op-icon';

            const text = document.createElement('span');
            text.className = 'ai-diff__op-text';

            const { label, iconText, iconClass } = this.#describeOperation(op);
            icon.textContent = iconText;
            icon.classList.add(iconClass);
            text.textContent = label;

            li.appendChild(icon);
            li.appendChild(text);
            list.appendChild(li);
        }

        this.#container.appendChild(list);
    }

    /**
     * Clear the rendered content.
     */
    clear() {
        if (this.#container) {
            this.#container.innerHTML = '';
        }
    }

    /**
     * Dispose of the renderer.
     */
    dispose() {
        this.clear();
        this.#container = null;
    }

    // ─── Private ────────────────────────────────────────────────────────

    /**
     * Generate a human-readable description for an operation.
     * @param {{ type: string, params: object }} op
     * @returns {{ label: string, iconText: string, iconClass: string }}
     */
    #describeOperation(op) {
        const p = op.params || {};

        switch (op.type) {
            case 'add_namespace':
                return {
                    label: `Add namespace "${p.display_name || p.displayName || 'Untitled'}"`,
                    iconText: '+',
                    iconClass: 'ai-diff__op-icon--add',
                };

            case 'remove_namespace':
                return {
                    label: `Remove namespace ${p.namespace_id || p.namespaceId || ''}`,
                    iconText: '-',
                    iconClass: 'ai-diff__op-icon--remove',
                };

            case 'add_node': {
                const nodeType = p.type || p.node_type || 'node';
                const key = p.config?.variableKey || p.config?.displayName || '';
                const desc = key ? `${nodeType} "${key}"` : nodeType;
                return {
                    label: `Add ${desc}`,
                    iconText: '+',
                    iconClass: 'ai-diff__op-icon--add',
                };
            }

            case 'remove_node':
                return {
                    label: `Remove node ${p.node_id || p.nodeId || ''}`,
                    iconText: '-',
                    iconClass: 'ai-diff__op-icon--remove',
                };

            case 'update_node': {
                const nodeId = p.node_id || p.nodeId || '';
                const fields = p.config ? Object.keys(p.config).join(', ') : '';
                return {
                    label: `Update node ${nodeId}${fields ? ` (${fields})` : ''}`,
                    iconText: '~',
                    iconClass: 'ai-diff__op-icon--modify',
                };
            }

            case 'move_node':
                return {
                    label: `Move node to (${p.x}, ${p.y})`,
                    iconText: '~',
                    iconClass: 'ai-diff__op-icon--modify',
                };

            case 'add_connection':
                return {
                    label: `Connect ${p.source_node_id || p.sourceNodeId || '?'} -> ${p.target_node_id || p.targetNodeId || '?'}`,
                    iconText: '+',
                    iconClass: 'ai-diff__op-icon--add',
                };

            case 'remove_connection':
                return {
                    label: `Remove connection ${p.connection_id || p.connectionId || ''}`,
                    iconText: '-',
                    iconClass: 'ai-diff__op-icon--remove',
                };

            case 'add_stock': {
                const name = p.account_name || p.accountName || '';
                const sector = p.sector || '';
                return {
                    label: `Add stock ${sector}${name ? `[${name}]` : ''}`,
                    iconText: '+',
                    iconClass: 'ai-diff__op-icon--add',
                };
            }

            case 'update_model_settings':
                return {
                    label: 'Update model settings',
                    iconText: '~',
                    iconClass: 'ai-diff__op-icon--modify',
                };

            default:
                return {
                    label: `${op.type}`,
                    iconText: '?',
                    iconClass: 'ai-diff__op-icon--unknown',
                };
        }
    }
}
