/**
 * charts.js — minimal inline SVG line charts.
 *
 * No chart library. Just enough to draw N series on the same axis with
 * a small legend, optional click → tick callback, and a vertical
 * "current viewing tick" indicator.
 *
 * Usage:
 *   renderLineChart(host, {
 *     series: [
 *       { name: 'Assets',      color: '#4ec9b0', points: [[0, 50], [1, 49], ...] },
 *       { name: 'Liabilities', color: '#d9886a', points: [...] },
 *     ],
 *     width: 320, height: 120,
 *     viewingTick: 37,        // optional vertical line
 *     onClickTick: (tick) => ...
 *   });
 */

/**
 * renderSparkline — minimal inline-SVG line chart suitable for embedding
 * in a table row. Just the polyline + last-value dot, no axes / legend /
 * grid. Returns an SVG string so callers can inline it.
 */
export function renderSparkline(points, {
    width = 80, height = 20, color = '#4ec9b0', viewingTick = null,
} = {}) {
    if (!Array.isArray(points) || points.length === 0) {
        return `<svg class="ea-spark ea-spark--empty" width="${width}" height="${height}"></svg>`;
    }
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const xMin = xs[0], xMax = xs[xs.length - 1];
    let yMin = Math.min(...ys), yMax = Math.max(...ys);
    if (yMin === yMax) {
        const eps = Math.abs(yMin) * 0.1 || 1;
        yMin -= eps; yMax += eps;
    }
    const xToPx = (x) => ((x - xMin) / Math.max(1, xMax - xMin)) * (width - 2) + 1;
    const yToPx = (y) => (1 - (y - yMin) / (yMax - yMin)) * (height - 2) + 1;
    const path = points.map((p) => `${xToPx(p[0]).toFixed(1)},${yToPx(p[1]).toFixed(1)}`).join(' ');
    const last = points[points.length - 1];
    const lastX = xToPx(last[0]).toFixed(1);
    const lastY = yToPx(last[1]).toFixed(1);
    let viewMark = '';
    if (viewingTick != null && viewingTick >= xMin && viewingTick <= xMax) {
        const vx = xToPx(viewingTick).toFixed(1);
        viewMark = `<line class="ea-spark__view" x1="${vx}" x2="${vx}" y1="1" y2="${height - 1}" />`;
    }
    return `
        <svg class="ea-spark" width="${width}" height="${height}"
             viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
            <polyline class="ea-spark__line" stroke="${color}" points="${path}" />
            ${viewMark}
            <circle class="ea-spark__dot" cx="${lastX}" cy="${lastY}" r="1.6" fill="${color}" />
        </svg>
    `;
}


export function renderLineChart(host, opts) {
    const {
        series = [],
        height = 120,
        padding = { top: 8, right: 12, bottom: 22, left: 36 },
        viewingTick = null,
        onClickTick = null,
        title = '',
    } = opts || {};
    // Render at the container's actual pixel width so axis-label text
    // stays at its CSS font-size — using a viewBox + width:100% would
    // stretch the SVG and inflate the internal `<text>` size with it.
    const intrinsic = Number(opts?.width) || 360;
    const width = Math.max(160,
        Math.floor(host.clientWidth || intrinsic));

    const allX = [];
    const allY = [];
    for (const s of series) {
        for (const [x, y] of (s.points || [])) {
            allX.push(x); allY.push(y);
        }
    }
    if (allX.length === 0) {
        host.innerHTML = '<div class="ea-chart__empty">No data yet — run the world to populate the chart.</div>';
        return;
    }

    const xMin = Math.min(...allX);
    const xMax = Math.max(...allX);
    let   yMin = Math.min(...allY);
    let   yMax = Math.max(...allY);
    if (yMin === yMax) {
        // Avoid zero range so the line isn't a flat smear at the bottom.
        const eps = Math.abs(yMin) * 0.1 || 1;
        yMin -= eps; yMax += eps;
    } else {
        // Add a 5% margin top/bottom for visual breathing room.
        const m = (yMax - yMin) * 0.05;
        yMin -= m; yMax += m;
    }

    const innerW = width - padding.left - padding.right;
    const innerH = height - padding.top - padding.bottom;
    const xToPx = (x) => padding.left + ((x - xMin) / Math.max(1e-9, (xMax - xMin))) * innerW;
    const yToPx = (y) => padding.top + (1 - (y - yMin) / Math.max(1e-9, (yMax - yMin))) * innerH;

    const lines = series.map((s) => {
        const pts = (s.points || []).map(([x, y]) => `${xToPx(x).toFixed(1)},${yToPx(y).toFixed(1)}`).join(' ');
        return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="1.5"/>`;
    }).join('');

    // X-axis ticks: a few labels at xMin / xMid / xMax.
    const xTicks = [];
    if (xMax > xMin) {
        const ticks = [xMin, Math.round((xMin + xMax) / 2), xMax];
        for (const t of ticks) {
            const px = xToPx(t);
            xTicks.push(`<text x="${px.toFixed(1)}" y="${(height - 6).toFixed(1)}" text-anchor="middle" class="ea-chart__tick-label">${t}</text>`);
        }
    }

    // Y-axis ticks: top, middle, bottom.
    const yTicks = [yMin, (yMin + yMax) / 2, yMax].map((v) => {
        const py = yToPx(v);
        const label = Number(v.toFixed(2)).toString();
        return `<text x="${(padding.left - 6).toFixed(1)}" y="${(py + 3).toFixed(1)}" text-anchor="end" class="ea-chart__tick-label">${label}</text>
                <line x1="${(padding.left).toFixed(1)}" x2="${(width - padding.right).toFixed(1)}"
                      y1="${py.toFixed(1)}" y2="${py.toFixed(1)}" class="ea-chart__grid"/>`;
    }).join('');

    const cursorLine = (viewingTick != null && viewingTick >= xMin && viewingTick <= xMax)
        ? `<line x1="${xToPx(viewingTick).toFixed(1)}" x2="${xToPx(viewingTick).toFixed(1)}"
                 y1="${padding.top.toFixed(1)}" y2="${(height - padding.bottom).toFixed(1)}"
                 class="ea-chart__cursor"/>`
        : '';

    const legend = series.map((s) => `
        <span class="ea-chart__legend-item">
            <span class="ea-chart__legend-swatch" style="background: ${s.color}"></span>${esc(s.name)}
        </span>
    `).join('');

    host.innerHTML = `
        <div class="ea-chart">
            ${title ? `<div class="ea-chart__title">${esc(title)}</div>` : ''}
            <svg width="${width}" height="${height}"
                 class="ea-chart__svg" xmlns="http://www.w3.org/2000/svg">
                <rect x="${padding.left}" y="${padding.top}" width="${innerW}" height="${innerH}"
                      class="ea-chart__plot"/>
                ${yTicks}
                ${lines}
                ${cursorLine}
                ${xTicks.join('')}
            </svg>
            <div class="ea-chart__legend">${legend}</div>
        </div>
    `;

    if (onClickTick) {
        const svg = host.querySelector('svg');
        svg.style.cursor = 'crosshair';
        svg.addEventListener('click', (e) => {
            const rect = svg.getBoundingClientRect();
            const px = (e.clientX - rect.left) * (width / rect.width);
            // Invert xToPx.
            const t = xMin + ((px - padding.left) / Math.max(1e-9, innerW)) * (xMax - xMin);
            onClickTick(Math.round(t));
        });
    }
}


function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
