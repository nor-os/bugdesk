/**
 * inspector.js — render and open a brain inspector as a floating window.
 *
 * Consumes the tree shape produced by `ecoagent.api.inspector.serialize_for_inspection`:
 *
 *   {kind: 'primitive', type, value}
 *   {kind: 'list', type, length, truncated, items: [...]}
 *   {kind: 'dict', type, length, truncated, items: {k: <node>}}
 *   {kind: 'object', type, length, truncated, attrs: {n: <node>}}
 *   {kind: 'elided', type, length}
 *   {kind: 'repr', type, repr}
 *
 * Renders an IDE-style collapsible tree. Clicking the chevron on a
 * collection toggles its children. Primitives render inline.
 *
 * Uses ManagedWindow rather than a modal overlay so the user can keep
 * one (or many) inspectors open while editing — same title reopens the
 * existing window with fresh content.
 */

import { renderSparkline } from './charts.js';


/**
 * Open the brain inspector as a floating, draggable window.
 *
 *   title      — used as the window's id (same title reuses the
 *                existing window). Pass a unique suffix if you want
 *                two independent inspectors for the same agent.
 *   node       — serialized tree from `serialize_for_inspection`.
 *   histories  — optional `{key: [[tick, value], ...]}` for top-level
 *                primitives; the inspector draws an inline sparkline
 *                for each match. Empty / undefined ⇒ no sparklines.
 *
 * Returns a Promise that resolves when the user closes the window
 * (legacy contract; current callers fire-and-forget).
 */
export async function openBrainInspector({ title, node, histories = {} }) {
    const { ManagedWindow } = await import('../../ui/components/managed_window.js');
    const winId = `ea-inspector:${title || 'brain'}`;
    const existing = ManagedWindow.get?.(winId);

    const treeHost = document.createElement('div');
    treeHost.className = 'ea-inspector__tree';
    renderNode(treeHost, '<root>', node, 0, /*expanded*/ true, histories || {});

    const body = document.createElement('div');
    body.className = 'ea-inspector__body ea-inspector__body--popout';
    body.appendChild(treeHost);

    if (existing && existing.contentContainer) {
        existing.contentContainer.innerHTML = '';
        existing.contentContainer.appendChild(body);
        existing.show();
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const win = new ManagedWindow({
            id: winId,
            title: title || 'Brain inspector',
            icon: 'psychology',
            content: body,
            minWidth: 360, minHeight: 240,
            defaultWidth: 560, defaultHeight: 480,
            modal: false,
            onClose: () => resolve(),
        });
        win.show();
    });
}


/**
 * Render a brain/inspection tree into an existing container — same tree
 * the popout window uses, but embeddable as a section inside another
 * surface (e.g. the agent dashboard). `host` should carry the
 * `ea-inspector__tree` class for the chevron / indentation styling.
 */
export function renderInspectorTree(host, node, histories = {}) {
    host.innerHTML = '';
    renderNode(host, '<root>', node, 0, /*expanded*/ true, histories || {});
}


function renderNode(container, name, node, depth, expanded, histories = {}) {
    const row = document.createElement('div');
    row.className = 'ea-inspector__node';
    row.style.paddingLeft = `${depth * 14}px`;
    container.appendChild(row);

    if (!node) {
        row.innerHTML = `<span class="ea-inspector__name">${esc(name)}</span>
                         <span class="ea-inspector__type">undefined</span>`;
        return;
    }

    const isCollection = node.kind === 'list' || node.kind === 'dict' || node.kind === 'object';
    const summary = describe(node);

    if (!isCollection) {
        // Sparkline lives between value and end-of-row for top-level
        // primitives we have history for. Drawn only if histories[name]
        // is a non-trivial series.
        const history = depth <= 1 ? histories[name] : null;
        const sparkSlot = (Array.isArray(history) && history.length > 1)
            ? `<span class="ea-inspector__spark">${
                renderSparkline(history, { width: 80, height: 14, color: '#4ec9b0' })
              }</span>`
            : '';
        row.innerHTML = `
            <span class="ea-inspector__chevron ea-inspector__chevron--leaf">·</span>
            <span class="ea-inspector__name">${esc(name)}</span>
            <span class="ea-inspector__type">${esc(node.type || node.kind)}</span>
            <span class="ea-inspector__value">${esc(summary)}</span>
            ${sparkSlot}
        `;
        return;
    }

    // Collection — collapsible.
    const wrap = document.createElement('div');
    wrap.className = 'ea-inspector__children';
    wrap.style.display = expanded ? '' : 'none';

    row.innerHTML = `
        <span class="ea-inspector__chevron"></span>
        <span class="ea-inspector__name">${esc(name)}</span>
        <span class="ea-inspector__type">${esc(node.type || node.kind)}${node.length != null ? `[${node.length}]` : ''}</span>
        <span class="ea-inspector__hint">${esc(summary)}</span>
    `;
    container.appendChild(wrap);

    const chev = row.querySelector('.ea-inspector__chevron');
    let isExpanded = expanded;
    const updateChev = () => { chev.textContent = isExpanded ? '▾' : '▸'; };
    updateChev();
    row.addEventListener('click', (e) => {
        // Toggle on click anywhere on the row.
        e.stopPropagation();
        isExpanded = !isExpanded;
        updateChev();
        wrap.style.display = isExpanded ? '' : 'none';
    });
    row.style.cursor = 'pointer';

    // Children.
    if (node.kind === 'list') {
        node.items.forEach((child, i) => {
            renderNode(wrap, `[${i}]`, child, depth + 1, false, histories);
        });
        if (node.truncated) {
            const more = document.createElement('div');
            more.className = 'ea-inspector__node ea-inspector__more';
            more.style.paddingLeft = `${(depth + 1) * 14}px`;
            more.textContent = `…${node.length - node.items.length} more elided`;
            wrap.appendChild(more);
        }
    } else if (node.kind === 'dict') {
        for (const [k, child] of Object.entries(node.items || {})) {
            renderNode(wrap, k, child, depth + 1, false, histories);
        }
        if (node.truncated) {
            const more = document.createElement('div');
            more.className = 'ea-inspector__node ea-inspector__more';
            more.style.paddingLeft = `${(depth + 1) * 14}px`;
            more.textContent = `…${node.length - Object.keys(node.items).length} more elided`;
            wrap.appendChild(more);
        }
    } else if (node.kind === 'object') {
        for (const [k, child] of Object.entries(node.attrs || {})) {
            renderNode(wrap, k, child, depth + 1, false, histories);
        }
        if (node.truncated) {
            const more = document.createElement('div');
            more.className = 'ea-inspector__node ea-inspector__more';
            more.style.paddingLeft = `${(depth + 1) * 14}px`;
            more.textContent = `…${node.length - Object.keys(node.attrs).length} more attrs elided`;
            wrap.appendChild(more);
        }
    }
}


function describe(node) {
    if (!node) return '';
    if (node.kind === 'primitive') {
        const v = node.value;
        if (typeof v === 'string') return JSON.stringify(v);
        return String(v);
    }
    if (node.kind === 'list')   return `${node.length} items`;
    if (node.kind === 'dict')   return `${node.length} keys`;
    if (node.kind === 'object') return `${node.length} attrs`;
    if (node.kind === 'elided') return '… (depth limit)';
    if (node.kind === 'repr')   return node.repr || '';
    return '';
}


function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
