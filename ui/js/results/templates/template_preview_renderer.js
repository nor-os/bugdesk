/**
 * template_preview_renderer.js
 *
 * Renders mini Plotly previews for template gallery cards.
 * Caches rendered previews as data-URL images to avoid repeated rendering.
 */

import { getDemoData } from './template_demo_data.js';
import { getWidgetMetadata } from '../tile_registry.js';

/** @type {Map<string, string>} templateId -> data URL */
const imageCache = new Map();

/**
 * Render a mini preview image for a template.
 * Returns a cached data-URL if available; otherwise renders via Plotly.
 *
 * @param {Object} template - Template definition
 * @returns {Promise<string|null>} Data URL of the preview image, or null
 */
export async function renderPreview(template) {
    if (imageCache.has(template.id)) {
        return imageCache.get(template.id);
    }

    const demoData = getDemoData(template.demoDataProfile || 'generic-static');
    if (!demoData) return null;

    // Create an off-screen container
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:380px;height:200px;';
    document.body.appendChild(container);

    try {
        const dataUrl = await _renderMiniDashboard(container, template, demoData);
        if (dataUrl) {
            imageCache.set(template.id, dataUrl);
        }
        return dataUrl;
    } finally {
        container.remove();
    }
}

/**
 * Render a mini dashboard layout into a container and capture as image.
 * Renders up to 4 tiles as tiny Plotly charts in their grid positions.
 *
 * @param {HTMLElement} container
 * @param {Object} template
 * @param {Object} demoData
 * @returns {Promise<string|null>}
 * @private
 */
async function _renderMiniDashboard(container, template, demoData) {
    const Plotly = window.Plotly;
    if (!Plotly) return null;

    const tiles = template.tiles || [];
    if (tiles.length === 0) return null;

    // Use a canvas-based approach: render each tile as a mini chart, composite onto one canvas
    const totalW = 380;
    const totalH = 200;

    // Compute grid bounds to normalize positions
    const maxCol = 12;
    const maxRow = Math.max(...tiles.map(t => t.y + t.h), 1);

    const cellW = totalW / maxCol;
    const cellH = totalH / Math.max(maxRow, 4); // Ensure reasonable cell height

    // Create a canvas for compositing
    const canvas = document.createElement('canvas');
    canvas.width = totalW * 2; // 2x for retina
    canvas.height = totalH * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);

    // Dark background
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, totalW, totalH);

    // Render up to 4 tiles (more would be too small)
    const tilesToRender = tiles.slice(0, 4);
    const renderPromises = tilesToRender.map(tile =>
        _renderMiniTile(ctx, tile, demoData, cellW, cellH, Plotly, container)
    );

    await Promise.all(renderPromises);

    return canvas.toDataURL('image/png');
}

/**
 * Render a single mini tile onto the canvas context.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} tile
 * @param {Object} demoData
 * @param {number} cellW
 * @param {number} cellH
 * @param {Object} Plotly
 * @param {HTMLElement} parentContainer - Off-screen container for temp Plotly renders
 * @private
 */
async function _renderMiniTile(ctx, tile, demoData, cellW, cellH, Plotly, parentContainer) {
    const x = tile.x * cellW;
    const y = tile.y * cellH;
    const w = tile.w * cellW;
    const h = tile.h * cellH;

    // Draw tile background
    ctx.fillStyle = '#252526';
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);

    // Draw tile border
    ctx.strokeStyle = '#3c3c3c';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

    // Build Plotly traces for this tile type
    const { traces, layout } = _buildMiniTraces(tile, demoData);
    if (!traces || traces.length === 0) {
        // Draw placeholder icon
        _drawPlaceholder(ctx, x, y, w, h, tile.type);
        return;
    }

    // Create a temp div for Plotly
    const plotDiv = document.createElement('div');
    plotDiv.style.cssText = `width:${Math.floor(w - 4)}px;height:${Math.floor(h - 4)}px;`;
    parentContainer.appendChild(plotDiv);

    try {
        const miniLayout = {
            ...layout,
            width: Math.floor(w - 4),
            height: Math.floor(h - 4),
            margin: { t: 2, r: 2, b: 2, l: 2 },
            paper_bgcolor: '#252526',
            plot_bgcolor: '#252526',
            showlegend: false,
            xaxis: {
                ...layout.xaxis,
                showgrid: false,
                showticklabels: false,
                zeroline: false,
                showline: false,
            },
            yaxis: {
                ...layout.yaxis,
                showgrid: false,
                showticklabels: false,
                zeroline: false,
                showline: false,
            },
        };

        await Plotly.newPlot(plotDiv, traces, miniLayout, {
            staticPlot: true,
            displayModeBar: false,
        });

        // Export to image
        const imgData = await Plotly.toImage(plotDiv, {
            format: 'png',
            width: Math.floor(w - 4) * 2,
            height: Math.floor(h - 4) * 2,
        });

        // Draw onto canvas
        const img = new Image();
        await new Promise((resolve) => {
            img.onload = resolve;
            img.onerror = resolve;
            img.src = imgData;
        });
        ctx.drawImage(img, x + 2, y + 2, w - 4, h - 4);

        Plotly.purge(plotDiv);
    } catch {
        _drawPlaceholder(ctx, x, y, w, h, tile.type);
    } finally {
        plotDiv.remove();
    }
}

/**
 * Draw a simple placeholder when Plotly rendering fails.
 * @private
 */
function _drawPlaceholder(ctx, x, y, w, h, type) {
    const meta = getWidgetMetadata(type);
    ctx.fillStyle = '#3c3c3c';
    ctx.font = '9px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(meta?.title || type, x + w / 2, y + h / 2);
}

/**
 * Build Plotly traces for a mini preview based on tile type and demo data.
 *
 * @param {Object} tile - Tile definition { type, config }
 * @param {Object} demoData - Demo data profile
 * @returns {{ traces: Array, layout: Object }}
 * @private
 */
function _buildMiniTraces(tile, demoData) {
    const time = demoData.time || [];
    const allVars = { ...demoData.stocks, ...demoData.flows, ...demoData.indicators };
    const varNames = Object.keys(allVars);

    const baseLayout = {
        xaxis: {},
        yaxis: {},
    };

    switch (tile.type) {
        case 'fan-chart': {
            const varName = tile.config?.variable || varNames[0];
            const varData = allVars[varName];
            if (!varData) return { traces: [], layout: baseLayout };

            const isMC = varData && typeof varData === 'object' && !Array.isArray(varData);
            const traces = [];

            if (isMC) {
                // Confidence band
                if (varData.p5 && varData.p95) {
                    traces.push({
                        x: time, y: varData.p95,
                        type: 'scatter', mode: 'lines',
                        line: { width: 0 }, showlegend: false,
                    });
                    traces.push({
                        x: time, y: varData.p5,
                        type: 'scatter', mode: 'lines',
                        fill: 'tonexty', fillcolor: 'rgba(33,150,243,0.15)',
                        line: { width: 0 }, showlegend: false,
                    });
                }
                // Mean line
                traces.push({
                    x: time, y: varData.mean,
                    type: 'scatter', mode: 'lines',
                    line: { color: '#2196F3', width: 1.5 },
                    showlegend: false,
                });
            } else {
                traces.push({
                    x: time, y: varData,
                    type: 'scatter', mode: 'lines',
                    line: { color: '#2196F3', width: 1.5 },
                    showlegend: false,
                });
            }
            return { traces, layout: baseLayout };
        }

        case 'phase-plot': {
            const xVar = tile.config?.xVariable || varNames[0];
            const yVar = tile.config?.yVariable || varNames[1] || varNames[0];
            const xData = _extractMean(allVars[xVar]);
            const yData = _extractMean(allVars[yVar]);
            if (!xData || !yData) return { traces: [], layout: baseLayout };

            return {
                traces: [{
                    x: xData, y: yData,
                    type: 'scatter', mode: 'lines',
                    line: { color: '#268bd2', width: 1.5 },
                    showlegend: false,
                }],
                layout: baseLayout,
            };
        }

        case 'statistics-table': {
            // Render a mini bar chart for summary stats
            const names = varNames.slice(0, 5);
            const values = names.map(n => {
                const d = _extractMean(allVars[n]);
                return d ? d[d.length - 1] : 0;
            });
            return {
                traces: [{
                    x: names, y: values,
                    type: 'bar',
                    marker: { color: '#4fc3f7' },
                }],
                layout: baseLayout,
            };
        }

        case 'tornado-diagram': {
            const names = varNames.slice(0, 4);
            const vals = names.map((_, i) => 10 + i * 5);
            return {
                traces: [{
                    y: names, x: vals,
                    type: 'bar', orientation: 'h',
                    marker: { color: '#ff7043' },
                }],
                layout: { ...baseLayout, yaxis: { automargin: true } },
            };
        }

        case 'distribution-histogram': {
            const varName = tile.config?.variable || varNames[0];
            const varData = allVars[varName];
            const mean = _extractMean(varData);
            if (!mean) return { traces: [], layout: baseLayout };
            return {
                traces: [{
                    x: mean, type: 'histogram',
                    marker: { color: '#ab47bc' },
                    nbinsx: 15,
                }],
                layout: baseLayout,
            };
        }

        case 'correlation-matrix':
        case 'jacobian-heatmap': {
            const n = Math.min(varNames.length, 4);
            const z = Array.from({ length: n }, (_, i) =>
                Array.from({ length: n }, (_, j) =>
                    i === j ? 1 : 0.3 + 0.4 * Math.sin(i * 3 + j * 7)
                )
            );
            return {
                traces: [{
                    z, type: 'heatmap',
                    colorscale: 'RdBu',
                    showscale: false,
                }],
                layout: baseLayout,
            };
        }

        case 'convergence-diagnostic': {
            const traces = [];
            for (let i = 0; i < 3; i++) {
                const y = time.map((_, j) => 1.0 + 0.3 * Math.exp(-j * 0.1) * Math.sin(j + i));
                traces.push({
                    x: time, y,
                    type: 'scatter', mode: 'lines',
                    line: { width: 1 },
                    showlegend: false,
                });
            }
            return { traces, layout: baseLayout };
        }

        case 'box-plot-timeline': {
            const varName = tile.config?.variable || varNames[0];
            const varData = allVars[varName];
            const isMC = varData && typeof varData === 'object' && !Array.isArray(varData);
            if (!isMC) return { traces: [], layout: baseLayout };

            // Sample a few time points for box plots
            const indices = [0, Math.floor(time.length / 4), Math.floor(time.length / 2), Math.floor(3 * time.length / 4), time.length - 1];
            const traces = indices.map(i => ({
                y: [varData.p5?.[i], varData.p25?.[i], varData.p50?.[i], varData.p75?.[i], varData.p95?.[i]],
                type: 'box',
                marker: { color: '#26a69a' },
                showlegend: false,
            }));
            return { traces, layout: baseLayout };
        }

        case 'stock-flow-decomposition': {
            // Show stacked area of a few flows
            const flowNames = Object.keys(demoData.flows || {}).slice(0, 3);
            if (flowNames.length === 0) {
                // Fallback: use stocks
                const stockName = Object.keys(demoData.stocks || {})[0];
                const d = _extractMean(demoData.stocks?.[stockName]);
                if (!d) return { traces: [], layout: baseLayout };
                return {
                    traces: [{
                        x: time, y: d,
                        type: 'scatter', mode: 'lines', fill: 'tozeroy',
                        fillcolor: 'rgba(76,175,80,0.3)',
                        line: { color: '#4caf50', width: 1 },
                        showlegend: false,
                    }],
                    layout: baseLayout,
                };
            }
            const colors = ['#4caf50', '#f44336', '#ff9800'];
            const traces = flowNames.map((name, i) => ({
                x: time, y: _extractMean(demoData.flows[name]),
                type: 'scatter', mode: 'lines',
                fill: i === 0 ? 'tozeroy' : 'tonexty',
                line: { color: colors[i], width: 1 },
                showlegend: false,
            }));
            return { traces, layout: baseLayout };
        }

        case 'sector-balance-sheet': {
            // Simple grouped bar
            const stockNames = Object.keys(demoData.stocks || {}).slice(0, 3);
            const values = stockNames.map(n => {
                const d = _extractMean(demoData.stocks[n]);
                return d ? d[d.length - 1] : 0;
            });
            return {
                traces: [{
                    x: stockNames, y: values,
                    type: 'bar',
                    marker: { color: '#78909c' },
                }],
                layout: baseLayout,
            };
        }

        default: {
            // Generic line chart with first variable
            const varData = allVars[varNames[0]];
            const mean = _extractMean(varData);
            if (!mean) return { traces: [], layout: baseLayout };
            return {
                traces: [{
                    x: time, y: mean,
                    type: 'scatter', mode: 'lines',
                    line: { color: '#888888', width: 1 },
                    showlegend: false,
                }],
                layout: baseLayout,
            };
        }
    }
}

/**
 * Extract mean/plain array from variable data.
 * @param {Array|Object} varData
 * @returns {Array|null}
 * @private
 */
function _extractMean(varData) {
    if (!varData) return null;
    if (Array.isArray(varData)) return varData;
    if (varData.mean) return varData.mean;
    return null;
}

/**
 * Clear the preview cache (e.g., after user templates change).
 */
export function clearPreviewCache() {
    imageCache.clear();
}
