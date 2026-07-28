/**
 * NotebookValidationIndicator
 *
 * Renders a compact status icon in the toolbar that shows validation state.
 * Clicking opens a popover listing errors/warnings, each clickable to navigate
 * to the source cell via `notebook:outline:jump`.
 */

export class NotebookValidationIndicator {

    /** @type {HTMLElement} */
    #container = null;

    /** @type {HTMLElement} */
    #iconEl = null;

    /** @type {HTMLElement|null} */
    #popoverEl = null;

    /** @type {import('./notebook_validation.js').ValidationStatus} */
    #status = { ok: true, errors: [], warnings: [], all: [] };

    /** @type {import('../core/event_bus.js').EventBus} */
    #eventBus = null;

    /** @type {Function|null} */
    #outsideClickHandler = null;

    /**
     * @param {{ eventBus: object }} deps
     */
    constructor({ eventBus }) {
        this.#eventBus = eventBus;
    }

    /**
     * Mount the indicator into a container element.
     * @param {HTMLElement} container
     */
    mount(container) {
        this.#container = container;

        const wrapper = document.createElement('div');
        wrapper.className = 'nb-validation-indicator';
        wrapper.title = 'Validation: OK';

        this.#iconEl = document.createElement('span');
        this.#iconEl.className = 'nb-validation-icon nb-validation-icon--ok';
        this.#iconEl.innerHTML = '<span class="material-symbols-outlined">check_circle</span>';

        wrapper.appendChild(this.#iconEl);
        wrapper.addEventListener('click', () => this.#togglePopover());

        this.#container.appendChild(wrapper);
    }

    /**
     * Update the indicator with new validation status.
     * @param {import('./notebook_validation.js').ValidationStatus} status
     */
    update(status) {
        this.#status = status;
        if (!this.#iconEl) return;

        const wrapper = this.#iconEl.parentElement;
        const errorCount = status.errors.length;
        const warnCount = status.warnings.length;

        // Update icon
        this.#iconEl.className = 'nb-validation-icon';
        if (errorCount > 0) {
            this.#iconEl.className += ' nb-validation-icon--error';
            this.#iconEl.innerHTML = '<span class="material-symbols-outlined">error</span>';
            wrapper.title = `${errorCount} error${errorCount !== 1 ? 's' : ''}${warnCount ? `, ${warnCount} warning${warnCount !== 1 ? 's' : ''}` : ''}`;
        } else if (warnCount > 0) {
            this.#iconEl.className += ' nb-validation-icon--warning';
            this.#iconEl.innerHTML = '<span class="material-symbols-outlined">warning</span>';
            wrapper.title = `${warnCount} warning${warnCount !== 1 ? 's' : ''}`;
        } else {
            this.#iconEl.className += ' nb-validation-icon--ok';
            this.#iconEl.innerHTML = '<span class="material-symbols-outlined">check_circle</span>';
            wrapper.title = 'Validation: OK';
        }

        // Update popover if open
        if (this.#popoverEl) this.#renderPopoverContent();
    }

    dispose() {
        this.#closePopover();
        this.#container?.querySelector('.nb-validation-indicator')?.remove();
        this.#container = null;
        this.#iconEl = null;
        this.#eventBus = null;
    }

    // ─── Popover ──────────────────────────────────────────────────────────────

    #togglePopover() {
        if (this.#popoverEl) {
            this.#closePopover();
        } else if (this.#status.all.length > 0) {
            this.#openPopover();
        }
    }

    #openPopover() {
        if (this.#popoverEl) return;

        this.#popoverEl = document.createElement('div');
        this.#popoverEl.className = 'nb-validation-popover';
        this.#renderPopoverContent();

        // Position below the indicator
        const wrapper = this.#iconEl?.parentElement;
        if (wrapper) {
            wrapper.style.position = 'relative';
            wrapper.appendChild(this.#popoverEl);
        }

        // Close on outside click
        this.#outsideClickHandler = (e) => {
            if (!this.#popoverEl?.contains(e.target) && !wrapper?.contains(e.target)) {
                this.#closePopover();
            }
        };
        setTimeout(() => document.addEventListener('click', this.#outsideClickHandler), 0);

        // Close on Escape
        this.#popoverEl.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.#closePopover();
        });
    }

    #closePopover() {
        if (this.#outsideClickHandler) {
            document.removeEventListener('click', this.#outsideClickHandler);
            this.#outsideClickHandler = null;
        }
        this.#popoverEl?.remove();
        this.#popoverEl = null;
    }

    #renderPopoverContent() {
        if (!this.#popoverEl) return;

        const { errors, warnings } = this.#status;

        // Group by file
        const byFile = new Map();
        for (const d of [...errors, ...warnings]) {
            const key = d.fileName ?? '(unknown)';
            if (!byFile.has(key)) byFile.set(key, []);
            byFile.get(key).push(d);
        }

        let html = '<div class="nb-validation-popover__header">';
        html += `<span>${errors.length} error${errors.length !== 1 ? 's' : ''}, ${warnings.length} warning${warnings.length !== 1 ? 's' : ''}</span>`;
        html += '<button class="nb-validation-popover__close" title="Close">';
        html += '<span class="material-symbols-outlined">close</span></button>';
        html += '</div>';
        html += '<div class="nb-validation-popover__body">';

        for (const [fileName, diagnostics] of byFile) {
            const shortName = fileName.split('/').pop() ?? fileName;
            html += `<div class="nb-validation-popover__file">${this.#escapeHtml(shortName)}</div>`;

            for (const d of diagnostics) {
                const icon = d.severity === 'error' ? 'error' : 'warning';
                const cls = d.severity === 'error' ? 'nb-validation-item--error' : 'nb-validation-item--warning';
                const lineInfo = d.cellLine > 0 ? ` :${d.cellLine}` : '';
                html += `<div class="nb-validation-item ${cls}" data-file="${this.#escapeAttr(d.fileName ?? '')}" data-cell="${this.#escapeAttr(d.cellId ?? '')}" data-line="${d.cellLine ?? 0}">`;
                html += `<span class="material-symbols-outlined nb-validation-item__icon">${icon}</span>`;
                html += `<span class="nb-validation-item__message">${this.#escapeHtml(d.message)}${lineInfo}</span>`;
                html += '</div>';
            }
        }

        html += '</div>';
        this.#popoverEl.innerHTML = html;

        // Wire close button
        this.#popoverEl.querySelector('.nb-validation-popover__close')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.#closePopover();
        });

        // Wire item clicks → navigate to source
        for (const item of this.#popoverEl.querySelectorAll('.nb-validation-item')) {
            item.addEventListener('click', () => {
                const fileName = item.dataset.file || null;
                const cellId = item.dataset.cell || null;
                const line = parseInt(item.dataset.line, 10) || null;
                if (cellId) {
                    this.#eventBus?.emit('notebook:outline:jump', {
                        name: '', // Not used for navigation by cellId
                        cellId,
                        fileName,
                        line,
                    });
                    this.#closePopover();
                }
            });
        }
    }

    #escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    #escapeAttr(s) {
        return s.replace(/"/g, '&quot;').replace(/&/g, '&amp;');
    }
}
