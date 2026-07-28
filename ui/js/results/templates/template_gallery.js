/**
 * template_gallery.js
 *
 * ManagedWindow modal for browsing and selecting dashboard templates.
 * Shows categorized cards with mini Plotly preview images, search,
 * and compatibility filtering.
 */

import { ManagedWindow } from '../../ui/components/managed_window.js';
import { TemplateRegistry } from './template_registry.js';
import { renderPreview, clearPreviewCache } from './template_preview_renderer.js';

/** @type {ManagedWindow|null} */
let _window = null;

/**
 * Open the template gallery modal.
 *
 * @param {Object} options
 * @param {string} options.runType - Current run type ('static' | 'monte-carlo')
 * @param {string[]} [options.scenarioTags] - Tags from current scenario
 * @param {string|null} [options.currentTemplateId] - Currently active template ID
 * @param {Function} options.onSelect - Callback when a template is selected: (templateDef) => void
 * @param {Function} [options.onSaveAsTemplate] - Callback for "Save as Template" action: (name) => string|null
 * @returns {Object} { close() } handle
 */
export function openTemplateGallery(options = {}) {
    if (_window?.isVisible) {
        _window.bringToFront();
        return { close: () => _window.close() };
    }

    const { runType = 'static', scenarioTags = [], currentTemplateId = null, onSelect, onSaveAsTemplate } = options;

    const content = _buildGalleryContent(runType, scenarioTags, currentTemplateId, onSelect, onSaveAsTemplate);

    _window = new ManagedWindow({
        id: 'template-gallery',
        title: 'Dashboard Templates',
        icon: 'auto_awesome_mosaic',
        content,
        minWidth: 500,
        minHeight: 400,
        defaultWidth: 720,
        defaultHeight: 520,
        canMinimize: false,
        canMaximize: true,
        canResize: true,
        canDrag: true,
        modal: true,
        onClose: () => { _window = null; },
    });

    _window.show();

    // Start loading previews asynchronously
    _loadPreviews(content);

    return { close: () => _window?.close() };
}

/**
 * Close the template gallery if open.
 */
export function closeTemplateGallery() {
    _window?.close();
}

/**
 * Build the gallery DOM content.
 * @private
 */
function _buildGalleryContent(runType, scenarioTags, currentTemplateId, onSelect, onSaveAsTemplate) {
    const root = document.createElement('div');
    root.className = 'template-gallery';

    // Search bar
    const searchBar = document.createElement('div');
    searchBar.className = 'template-gallery__search';
    searchBar.innerHTML = `<input type="text" class="template-gallery__search-input" placeholder="Search templates..." />`;
    root.appendChild(searchBar);

    // Scrollable body
    const body = document.createElement('div');
    body.className = 'template-gallery__body';
    root.appendChild(body);

    // Render catalog
    _renderCatalog(body, runType, currentTemplateId, onSelect);

    // Wire search
    const searchInput = searchBar.querySelector('.template-gallery__search-input');
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            _renderCatalog(body, runType, currentTemplateId, onSelect, searchInput.value);
            _loadPreviews(root);
        }, 200);
    });

    // Focus search on open
    requestAnimationFrame(() => searchInput.focus());

    // Footer with "Save as Template"
    if (onSaveAsTemplate) {
        const footer = document.createElement('div');
        footer.className = 'template-gallery__footer';
        footer.innerHTML = `
            <button class="template-gallery__save-btn">
                <span class="material-symbols-outlined">bookmark_add</span>
                Save Current as Template
            </button>
        `;
        footer.querySelector('.template-gallery__save-btn').addEventListener('click', () => {
            _handleSaveAsTemplate(onSaveAsTemplate, body, runType, currentTemplateId, onSelect);
        });
        root.appendChild(footer);
    }

    return root;
}

/**
 * Render the categorized template catalog into the body element.
 * @private
 */
function _renderCatalog(body, runType, currentTemplateId, onSelect, search) {
    body.innerHTML = '';

    const catalog = TemplateRegistry.getCatalog({ runType, search });

    if (catalog.length === 0 || catalog.every(g => g.templates.length === 0)) {
        body.innerHTML = `
            <div class="template-gallery__empty">
                <span class="material-symbols-outlined">search_off</span>
                <span class="template-gallery__empty-text">No templates found</span>
            </div>
        `;
        return;
    }

    for (const group of catalog) {
        if (group.templates.length === 0) continue;

        const section = document.createElement('div');
        section.className = 'template-gallery__category';

        // Category header
        const header = document.createElement('div');
        header.className = 'template-gallery__category-header';
        header.innerHTML = `
            <span class="material-symbols-outlined template-gallery__category-icon">${group.categoryMeta.icon}</span>
            <span class="template-gallery__category-name">${group.categoryMeta.displayName}</span>
            <span class="material-symbols-outlined template-gallery__category-chevron">expand_more</span>
        `;
        header.addEventListener('click', () => {
            section.classList.toggle('template-gallery__category--collapsed');
        });
        section.appendChild(header);

        // Card grid
        const grid = document.createElement('div');
        grid.className = 'template-gallery__category-grid';

        for (const template of group.templates) {
            const card = _buildCard(template, currentTemplateId, runType, onSelect, body);
            grid.appendChild(card);
        }

        section.appendChild(grid);
        body.appendChild(section);
    }
}

/**
 * Build a single template card element.
 * @private
 */
function _buildCard(template, currentTemplateId, runType, onSelect, bodyEl) {
    const card = document.createElement('div');
    card.className = 'template-gallery__card';

    const isActive = template.id === currentTemplateId;
    const isCompatible = template.compatible !== false;

    if (isActive) card.classList.add('template-gallery__card--active');
    if (!isCompatible) card.classList.add('template-gallery__card--incompatible');

    // Preview area
    const preview = document.createElement('div');
    preview.className = 'template-gallery__card-preview';
    preview.innerHTML = `
        <div class="template-gallery__card-preview-placeholder">
            <span class="material-symbols-outlined">${template.icon || 'dashboard'}</span>
        </div>
    `;
    // data-template-id for async preview loading
    preview.dataset.templateId = template.id;
    card.appendChild(preview);

    // User template delete button
    if (template.source === 'user') {
        const actions = document.createElement('div');
        actions.className = 'template-gallery__card-actions';
        actions.innerHTML = `
            <button class="template-gallery__card-action-btn" title="Delete template">
                <span class="material-symbols-outlined">delete</span>
            </button>
        `;
        actions.querySelector('button').addEventListener('click', (e) => {
            e.stopPropagation();
            _handleDeleteUserTemplate(template.id, bodyEl, runType, currentTemplateId, onSelect);
        });
        preview.style.position = 'relative';
        preview.appendChild(actions);
    }

    // Info
    const info = document.createElement('div');
    info.className = 'template-gallery__card-info';
    info.innerHTML = `
        <span class="template-gallery__card-title">${_escapeHtml(template.name)}</span>
        <span class="template-gallery__card-desc">${_escapeHtml(template.description || '')}</span>
    `;
    card.appendChild(info);

    // Footer with badges
    const footer = document.createElement('div');
    footer.className = 'template-gallery__card-footer';

    const compatLabel = template.compatibility === 'monte-carlo' ? 'MC'
        : template.compatibility === 'both' ? 'Both'
        : 'Static';
    const compatClass = template.compatibility === 'monte-carlo' ? 'mc'
        : template.compatibility === 'both' ? 'both'
        : 'static';

    footer.innerHTML = `
        <span class="template-gallery__badge template-gallery__badge--${compatClass}">${compatLabel}</span>
        ${template.source === 'user' ? '<span class="template-gallery__badge template-gallery__badge--user">Custom</span>' : ''}
        ${template.source === 'workspace' ? '<span class="template-gallery__badge template-gallery__badge--workspace">Workspace</span>' : ''}
        <span class="template-gallery__card-tiles">${template.tiles?.length || 0} tiles</span>
    `;
    card.appendChild(footer);

    // Click to select
    if (isCompatible) {
        card.addEventListener('click', () => {
            onSelect?.(template);
            _window?.close();
        });
    }

    return card;
}

/**
 * Load preview images asynchronously and inject into cards.
 * @private
 */
async function _loadPreviews(root) {
    const previews = root.querySelectorAll('.template-gallery__card-preview[data-template-id]');

    for (const previewEl of previews) {
        const templateId = previewEl.dataset.templateId;
        const template = TemplateRegistry.get(templateId);
        if (!template) continue;

        // Don't re-render if already has an image
        if (previewEl.querySelector('img')) continue;

        // Render asynchronously (don't await in loop — fire all)
        renderPreview(template).then(dataUrl => {
            if (!dataUrl) return;
            // Check element still exists in DOM
            if (!previewEl.isConnected) return;

            const img = document.createElement('img');
            img.src = dataUrl;
            img.alt = template.name;

            // Replace placeholder
            const placeholder = previewEl.querySelector('.template-gallery__card-preview-placeholder');
            if (placeholder) placeholder.remove();
            previewEl.prepend(img);
        });
    }
}

/**
 * Handle "Save as Template" button click.
 * @private
 */
async function _handleSaveAsTemplate(onSaveAsTemplate, bodyEl, runType, currentTemplateId, onSelect) {
    const name = prompt('Template name:');
    if (!name?.trim()) return;

    const templateId = onSaveAsTemplate(name.trim());
    if (templateId) {
        // Clear preview cache since a new template was added
        clearPreviewCache();
        // Re-render catalog to show new template
        _renderCatalog(bodyEl, runType, currentTemplateId, onSelect);
        _loadPreviews(bodyEl.closest('.template-gallery'));
    }
}

/**
 * Handle deleting a user template.
 * @private
 */
function _handleDeleteUserTemplate(templateId, bodyEl, runType, currentTemplateId, onSelect) {
    const template = TemplateRegistry.get(templateId);
    if (!template) return;

    if (!confirm(`Delete template "${template.name}"?`)) return;

    TemplateRegistry.deleteUserTemplate(templateId);
    clearPreviewCache();
    _renderCatalog(bodyEl, runType, currentTemplateId, onSelect);
    _loadPreviews(bodyEl.closest('.template-gallery'));
}

/**
 * Escape HTML special characters.
 * @private
 */
function _escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
