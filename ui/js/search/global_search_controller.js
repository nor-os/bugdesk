/**
 * Global Search Controller
 *
 * UI controller for the global search component in the top bar.
 * Provides search input, keyboard navigation, and result selection.
 *
 * Searches symbols, files, scenarios, and cells in the notebook workspace.
 * Navigates by emitting 'project:file:request-open' events.
 *
 * Special prefix commands:
 * - "help ..." - Searches help topics instead of workspace items
 */

import { getHelpService } from '../help/help_service.js';
import { HelpModal } from '../help/help_modal.js';

const SEARCH_EVENTS = Object.freeze({
    SYMBOL_SELECTED: 'search:symbol:selected',
    FILE_SELECTED: 'search:file:selected',
    CELL_SELECTED: 'search:cell:selected',
});

const DEBOUNCE_MS = 100;

export class GlobalSearchController {
    constructor({
        eventBus,
        searchService,
        logger = null,
    } = {}) {
        this.eventBus = eventBus;
        this.searchService = searchService;
        this.logger = logger;

        this.container = null;
        this.inputEl = null;
        this.dropdownEl = null;
        this.results = { symbols: [], files: [], scenarios: [], cells: [] };
        this.flatResults = [];
        this.selectedIndex = -1;
        this.isOpen = false;
        this.debounceTimer = null;

        this._onDocumentClick = null;
        this._onGlobalKeydown = null;
    }

    /**
     * Mount the search UI to a container element.
     * @param {HTMLElement} container - The container to mount into (bar-center)
     */
    mount(container) {
        if (!container) {
            console.error('[GlobalSearch] mount() called without container');
            throw new Error('GlobalSearchController.mount requires a container element');
        }
        this.container = container;
        this.container.innerHTML = '';
        this.container.classList.add('global-search-container');

        this.#buildUI();
        this.#bindEvents();
    }

    dispose() {
        if (this._onDocumentClick) {
            document.removeEventListener('click', this._onDocumentClick, true);
        }
        if (this._onGlobalKeydown) {
            document.removeEventListener('keydown', this._onGlobalKeydown, true);
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        if (this.container) {
            this.container.innerHTML = '';
        }
        this.container = null;
        this.inputEl = null;
        this.dropdownEl = null;
    }

    #buildUI() {
        const wrapper = document.createElement('div');
        wrapper.className = 'global-search-wrapper';

        const icon = document.createElement('span');
        icon.className = 'global-search-icon material-symbols-outlined';
        icon.textContent = 'search';
        wrapper.appendChild(icon);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'global-search-input';
        input.placeholder = 'Search symbols, files, scenarios...';
        input.setAttribute('aria-label', 'Global search');
        input.autocomplete = 'off';
        this.inputEl = input;
        wrapper.appendChild(input);

        const hint = document.createElement('span');
        hint.className = 'global-search-hint';
        const isMac = navigator.platform?.toUpperCase().includes('MAC');
        hint.textContent = isMac ? '\u2318K' : 'Ctrl+K';
        wrapper.appendChild(hint);

        const dropdown = document.createElement('div');
        dropdown.className = 'global-search-dropdown';
        dropdown.setAttribute('role', 'listbox');
        dropdown.style.display = 'none';
        this.dropdownEl = dropdown;

        this.container.appendChild(wrapper);
        this.container.appendChild(dropdown);
    }

    #bindEvents() {
        this.inputEl.addEventListener('input', () => this.#handleInput());
        this.inputEl.addEventListener('focus', () => this.#handleFocus());
        this.inputEl.addEventListener('keydown', (e) => this.#handleKeydown(e));

        this._onDocumentClick = (e) => {
            if (!this.container?.contains(e.target)) {
                this.#closeDropdown();
            }
        };
        document.addEventListener('click', this._onDocumentClick, true);

        this._onGlobalKeydown = (e) => {
            const isMac = navigator.platform?.toUpperCase().includes('MAC');
            const modifier = isMac ? e.metaKey : e.ctrlKey;
            if (modifier && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                this.inputEl?.focus();
                this.inputEl?.select();
            }
        };
        document.addEventListener('keydown', this._onGlobalKeydown, true);
    }

    #handleInput() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.#performSearch();
        }, DEBOUNCE_MS);
    }

    #handleFocus() {
        const query = this.inputEl?.value?.trim() || '';
        if (query && this.flatResults.length > 0) {
            this.#openDropdown();
        }
    }

    #handleKeydown(e) {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this.#moveSelection(1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.#moveSelection(-1);
                break;
            case 'Enter':
                e.preventDefault();
                this.#selectCurrent();
                break;
            case 'Escape':
                e.preventDefault();
                this.#closeDropdown();
                this.inputEl?.blur();
                break;
        }
    }

    async #performSearch() {
        const query = this.inputEl?.value?.trim() || '';

        if (!query) {
            this.#closeDropdown();
            return;
        }

        // Check for "help" prefix
        const helpMatch = query.match(/^help\s+(.+)$/i);
        if (helpMatch || query.toLowerCase() === 'help') {
            const helpQuery = helpMatch ? helpMatch[1] : '';
            this.#performHelpSearch(helpQuery);
            return;
        }

        if (!this.searchService) {
            this.logger?.warn?.('global-search', 'Search service not available');
            return;
        }

        this.results = await this.searchService.search(query, { maxResults: 5 });

        // Check if input changed while awaiting (user kept typing)
        if (this.inputEl?.value?.trim() !== query) return;

        this.#buildFlatResults();

        if (this.flatResults.length > 0) {
            this.#renderDropdown();
            this.#openDropdown();
        } else {
            this.#renderEmpty();
            this.#openDropdown();
        }
    }

    #performHelpSearch(query) {
        const helpService = getHelpService();

        if (!query) {
            const categories = helpService.getCategories();
            this.flatResults = categories.map(cat => ({
                id: cat,
                category: 'help-category',
                name: this.#getCategoryLabel(cat),
                icon: this.#getCategoryIcon(cat),
            }));
        } else {
            const topics = helpService.searchTopics(query);
            this.flatResults = topics.map(topic => ({
                id: topic.id,
                category: 'help',
                name: topic.title,
                categoryName: this.#getCategoryLabel(topic.category),
                icon: 'help',
            }));
        }

        this.selectedIndex = this.flatResults.length > 0 ? 0 : -1;

        if (this.flatResults.length > 0) {
            this.#renderHelpDropdown();
            this.#openDropdown();
        } else {
            this.#renderEmpty();
            this.#openDropdown();
        }
    }

    #getCategoryLabel(category) {
        const labels = {
            basics: 'Getting Started',
            nodes: 'Node Types',
            expressions: 'Expressions & Formulas',
            simulation: 'Simulation',
            accounting: 'Stock-Flow Accounting',
            functions: 'Functions & Modules',
            'node-addons': 'Node Addons',
            data: 'Data Management',
            results: 'Results & Export',
        };
        return labels[category] || category;
    }

    #getCategoryIcon(category) {
        const icons = {
            basics: 'school',
            nodes: 'hub',
            expressions: 'calculate',
            simulation: 'play_circle',
            accounting: 'account_balance',
            functions: 'functions',
            'node-addons': 'extension',
            data: 'database',
            results: 'insights',
        };
        return icons[category] || 'help';
    }

    #renderHelpDropdown() {
        if (!this.dropdownEl) return;
        this.dropdownEl.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'global-search-section-header';

        const headerIcon = document.createElement('span');
        headerIcon.className = 'section-icon material-symbols-outlined';
        headerIcon.textContent = 'help';
        header.appendChild(headerIcon);

        const headerText = document.createElement('span');
        headerText.className = 'section-title';
        headerText.textContent = 'Help Topics';
        header.appendChild(headerText);

        this.dropdownEl.appendChild(header);

        this.flatResults.forEach((item, i) => {
            const el = document.createElement('div');
            el.className = 'global-search-result';
            el.setAttribute('role', 'option');
            el.dataset.index = i;

            const icon = document.createElement('span');
            icon.className = 'result-icon material-symbols-outlined';
            icon.textContent = item.icon;
            el.appendChild(icon);

            const textContainer = document.createElement('div');
            textContainer.className = 'result-text';

            const primary = document.createElement('span');
            primary.className = 'result-primary';
            primary.textContent = item.name;
            textContainer.appendChild(primary);

            if (item.categoryName) {
                const secondary = document.createElement('span');
                secondary.className = 'result-secondary';
                secondary.textContent = item.categoryName;
                textContainer.appendChild(secondary);
            }

            el.appendChild(textContainer);

            el.addEventListener('click', () => {
                this.selectedIndex = i;
                this.#selectCurrent();
            });

            el.addEventListener('mouseenter', () => {
                this.selectedIndex = i;
                this.#updateSelectionHighlight();
            });

            this.dropdownEl.appendChild(el);
        });

        this.#updateSelectionHighlight();
    }

    #buildFlatResults() {
        this.flatResults = [
            ...this.results.symbols.map(r => ({ ...r, category: 'symbol' })),
            ...this.results.files.map(r => ({ ...r, category: 'file' })),
            ...this.results.scenarios.map(r => ({ ...r, category: 'scenario' })),
            ...this.results.cells.map(r => ({ ...r, category: 'cell' })),
        ];
        this.selectedIndex = this.flatResults.length > 0 ? 0 : -1;
    }

    #renderDropdown() {
        if (!this.dropdownEl) return;
        this.dropdownEl.innerHTML = '';

        let flatIndex = 0;

        // Symbols section
        if (this.results.symbols.length > 0) {
            this.#renderSection('Symbols', 'code', this.results.symbols, flatIndex, (item) => ({
                primary: item.displayName || item.name,
                secondary: item.kind,
                badge: item.namespace || item.fileName?.split('/').pop()?.replace(/\.[^.]+$/, ''),
                icon: this.#getSymbolIcon(item.kind),
            }));
            flatIndex += this.results.symbols.length;
        }

        // Files section
        if (this.results.files.length > 0) {
            this.#renderSection('Files', 'description', this.results.files, flatIndex, (item) => ({
                primary: item.name,
                secondary: item.fileType,
                badge: null,
                icon: this.#getFileIcon(item.fileType),
            }));
            flatIndex += this.results.files.length;
        }

        // Scenarios section
        if (this.results.scenarios.length > 0) {
            this.#renderSection('Scenarios', 'play_circle', this.results.scenarios, flatIndex, (item) => ({
                primary: item.name,
                secondary: item.description || (item.type === 'monte-carlo' ? 'Monte Carlo' : item.type),
                badge: null,
                icon: item.type === 'monte-carlo' ? 'casino' : 'play_arrow',
            }));
            flatIndex += this.results.scenarios.length;
        }

        // Cells section
        if (this.results.cells.length > 0) {
            this.#renderSection('Content', 'article', this.results.cells, flatIndex, (item) => ({
                primary: item.name,
                secondary: item.cellKind,
                badge: item.fileBasename,
                icon: this.#getCellIcon(item.cellKind),
            }));
        }

        this.#updateSelectionHighlight();
    }

    #getSymbolIcon(kind) {
        const iconMap = {
            'variable': 'function',
            'parameter': 'tune',
            'stock': 'account_balance',
            'namespace': 'dataset',
            'import': 'input',
            'generator': 'waves',
            'smooth': 'show_chart',
            'pid': 'tune',
            'schedule': 'event_note',
            'delay': 'timer',
            'latch': 'toggle_on',
            'time': 'schedule',
            'function': 'calculate',
        };
        return iconMap[kind] || 'code';
    }

    #getFileIcon(fileType) {
        const iconMap = {
            'namespace': 'dataset',
            'scenario': 'play_circle',
            'module': 'extension',
            'test': 'fact_check',
            'dashboard': 'dashboard',
            'calibration': 'tune',
            'orchestration': 'account_tree',
            'pipeline': 'route',
        };
        return iconMap[fileType] || 'description';
    }

    #getCellIcon(cellKind) {
        const iconMap = {
            'heading': 'title',
            'godley': 'grid_on',
            'documentation': 'article',
        };
        return iconMap[cellKind] || 'article';
    }

    #renderSection(title, categoryIcon, items, startIndex, getDisplay) {
        const header = document.createElement('div');
        header.className = 'global-search-section-header';

        const headerIcon = document.createElement('span');
        headerIcon.className = 'section-icon material-symbols-outlined';
        headerIcon.textContent = categoryIcon;
        header.appendChild(headerIcon);

        const headerText = document.createElement('span');
        headerText.className = 'section-title';
        headerText.textContent = title;
        header.appendChild(headerText);

        this.dropdownEl.appendChild(header);

        items.forEach((item, i) => {
            const display = getDisplay(item);
            const el = document.createElement('div');
            el.className = 'global-search-result';
            el.setAttribute('role', 'option');
            el.dataset.index = startIndex + i;

            const icon = document.createElement('span');
            icon.className = 'result-icon material-symbols-outlined';
            icon.textContent = display.icon;
            el.appendChild(icon);

            const textContainer = document.createElement('div');
            textContainer.className = 'result-text';

            const primary = document.createElement('span');
            primary.className = 'result-primary';
            primary.textContent = display.primary;
            textContainer.appendChild(primary);

            if (display.secondary) {
                const secondary = document.createElement('span');
                secondary.className = 'result-secondary';
                secondary.textContent = display.secondary;
                textContainer.appendChild(secondary);
            }

            el.appendChild(textContainer);

            if (display.badge) {
                const badge = document.createElement('span');
                badge.className = 'result-badge';
                badge.textContent = display.badge;
                el.appendChild(badge);
            }

            el.addEventListener('click', () => {
                this.selectedIndex = startIndex + i;
                this.#selectCurrent();
            });

            el.addEventListener('mouseenter', () => {
                this.selectedIndex = startIndex + i;
                this.#updateSelectionHighlight();
            });

            this.dropdownEl.appendChild(el);
        });
    }

    #renderEmpty() {
        if (!this.dropdownEl) return;
        this.dropdownEl.innerHTML = '';

        const empty = document.createElement('div');
        empty.className = 'global-search-empty';
        empty.textContent = 'No results found';
        this.dropdownEl.appendChild(empty);
    }

    #openDropdown() {
        if (!this.dropdownEl) return;
        this.dropdownEl.style.display = 'block';
        this.isOpen = true;
    }

    #closeDropdown() {
        if (!this.dropdownEl) return;
        this.dropdownEl.style.display = 'none';
        this.isOpen = false;
        this.selectedIndex = -1;
    }

    #moveSelection(delta) {
        if (!this.isOpen || this.flatResults.length === 0) return;

        const newIndex = this.selectedIndex + delta;
        if (newIndex >= 0 && newIndex < this.flatResults.length) {
            this.selectedIndex = newIndex;
            this.#updateSelectionHighlight();
            this.#scrollSelectedIntoView();
        }
    }

    #updateSelectionHighlight() {
        if (!this.dropdownEl) return;

        const items = this.dropdownEl.querySelectorAll('.global-search-result');
        items.forEach((item) => {
            const index = parseInt(item.dataset.index, 10);
            if (index === this.selectedIndex) {
                item.classList.add('selected');
                item.setAttribute('aria-selected', 'true');
            } else {
                item.classList.remove('selected');
                item.setAttribute('aria-selected', 'false');
            }
        });
    }

    #scrollSelectedIntoView() {
        const selected = this.dropdownEl?.querySelector('.global-search-result.selected');
        if (selected) {
            selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    #selectCurrent() {
        if (this.selectedIndex < 0 || this.selectedIndex >= this.flatResults.length) {
            return;
        }

        const item = this.flatResults[this.selectedIndex];
        this.#closeDropdown();
        this.inputEl.value = '';

        switch (item.category) {
            case 'symbol':
                this.#navigateToSymbol(item);
                break;
            case 'file':
                this.#navigateToFile(item);
                break;
            case 'scenario':
                this.#navigateToFile(item);
                break;
            case 'cell':
                this.#navigateToCell(item);
                break;
            case 'help':
                HelpModal.open(item.id);
                break;
            case 'help-category':
                HelpModal.open();
                break;
        }
    }

    /**
     * Open a file in the notebook, optionally scrolling to a cell.
     * Emits project:file:request-open which NotebookPage handles.
     */
    #openInNotebook(filePath, cellId) {
        this.eventBus?.emit?.('project:file:request-open', { filePath, cellId });
    }

    #navigateToSymbol(item) {
        this.#openInNotebook(item.fileName, item.cellId);
        this.eventBus?.emit?.(SEARCH_EVENTS.SYMBOL_SELECTED, {
            name: item.name,
            fileName: item.fileName,
            cellId: item.cellId,
        });
    }

    #navigateToFile(item) {
        this.#openInNotebook(item.path);
        this.eventBus?.emit?.(SEARCH_EVENTS.FILE_SELECTED, {
            filePath: item.path,
        });
    }

    #navigateToCell(item) {
        this.#openInNotebook(item.fileName, item.cellId);
        this.eventBus?.emit?.(SEARCH_EVENTS.CELL_SELECTED, {
            fileName: item.fileName,
            cellId: item.cellId,
        });
    }
}

GlobalSearchController.EVENTS = SEARCH_EVENTS;
