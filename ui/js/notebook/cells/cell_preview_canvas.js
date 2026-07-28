/**
 * CellPreviewCanvas — live computed function preview for notebook cells.
 *
 * - plotFunction / plotPoints → Canvas (high-sample-count curves)
 * - plotSchematic → SVG (block diagrams with crisp text at any DPI)
 *
 * Usage:
 *   const preview = new CellPreviewCanvas(containerEl, { color: '#2aa198' });
 *   preview.plotFunction(x => 1 / (1 + Math.exp(-x)), { xMin: -6, xMax: 6 });
 *   preview.plotPoints([{x:0,y:0},{x:1,y:1},{x:2,y:0.5}]);
 *   preview.plotSchematic((svg, w, h, color) => { svg.rect(0, 0, w, h, { fill: color }); });
 *   preview.dispose();
 */

import { createRafResizeObserver } from '../../ui/utils/raf_resize_observer.js';

const NS = 'http://www.w3.org/2000/svg';

/** Live DPR — read on every frame so zoom / monitor changes are picked up. */
const dpr = () => window.devicePixelRatio || 1;

// ─── SVG schematic builder ───────────────────────────────────

/**
 * Lightweight builder that creates SVG child elements.
 * Passed to plotSchematic callbacks in place of the old canvas context.
 */
export class SvgSchematic {
    /** @type {SVGSVGElement} */
    #svg;

    constructor(svg) { this.#svg = svg; }

    /** Straight line. */
    line(x1, y1, x2, y2, { stroke = '#fff', width = 1.5, dash } = {}) {
        const el = this.#el('line', { x1, y1, x2, y2, stroke, 'stroke-width': width });
        if (dash) el.setAttribute('stroke-dasharray', dash);
        return el;
    }

    /** Rounded rectangle. */
    rect(x, y, w, h, { fill = 'none', stroke = 'none', strokeWidth = 1.5, r = 0 } = {}) {
        return this.#el('rect', {
            x, y, width: w, height: h, rx: r, ry: r,
            fill, stroke, 'stroke-width': strokeWidth,
        });
    }

    /** Circle. */
    circle(cx, cy, r, { fill = 'none', stroke = 'none', strokeWidth = 1.5 } = {}) {
        return this.#el('circle', { cx, cy, r, fill, stroke, 'stroke-width': strokeWidth });
    }

    /** Text label. */
    text(str, x, y, {
        fill = '#fff', font = '9px "Segoe UI", system-ui, sans-serif',
        anchor = 'start', baseline = 'middle', weight,
    } = {}) {
        const el = this.#el('text', {
            x, y, fill,
            'font': font,
            'text-anchor': anchor,
            'dominant-baseline': baseline,
        });
        if (weight) el.style.fontWeight = weight;
        el.textContent = str;
        return el;
    }

    /** Material Symbols icon (rendered as text with icon font). */
    icon(name, x, y, { size = 20, fill = '#fff' } = {}) {
        return this.text(name, x, y, {
            fill,
            font: `${size}px "Material Symbols Outlined"`,
            anchor: 'middle',
            baseline: 'central',
        });
    }

    /** Filled polygon (e.g. arrowhead). Points: [[x,y], ...] */
    polygon(points, { fill = '#fff', stroke = 'none' } = {}) {
        return this.#el('polygon', {
            points: points.map(p => p.join(',')).join(' '),
            fill, stroke,
        });
    }

    /** SVG <path>. */
    path(d, { stroke = '#fff', width = 1.5, fill = 'none', dash } = {}) {
        const el = this.#el('path', { d, stroke, 'stroke-width': width, fill });
        if (dash) el.setAttribute('stroke-dasharray', dash);
        return el;
    }

    /** Open SVG <g> group — push. Returns the group element. */
    group(attrs = {}) {
        const g = document.createElementNS(NS, 'g');
        for (const [k, v] of Object.entries(attrs)) g.setAttribute(k, v);
        this.#svg.appendChild(g);
        const prev = this.#svg;
        this.#svg = g;
        return { el: g, pop: () => { this.#svg = prev; } };
    }

    /** Measure approximate text width (sans full layout). */
    measureText(str, font = '11px "Consolas", monospace') {
        // Use a temporary SVG text node for accurate measurement
        const el = document.createElementNS(NS, 'text');
        el.setAttribute('font', font);
        el.textContent = str;
        // Append to root SVG (must be in DOM for getComputedTextLength)
        const root = this.#rootSvg();
        root.appendChild(el);
        const w = el.getComputedTextLength();
        root.removeChild(el);
        return w;
    }

    // ── helpers ──

    /** Walk up to the root <svg> (may be inside a <g>). */
    #rootSvg() {
        let el = this.#svg;
        while (el.ownerSVGElement) el = el.ownerSVGElement;
        return el;
    }

    #el(tag, attrs) {
        const el = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v != null) el.setAttribute(k, String(v));
        }
        this.#svg.appendChild(el);
        return el;
    }
}

// ─── Main preview widget ─────────────────────────────────────

export class CellPreviewCanvas {
    /** @type {HTMLCanvasElement} */
    #canvas = null;
    /** @type {CanvasRenderingContext2D} */
    #ctx = null;
    /** @type {SVGSVGElement|null} */
    #svg = null;
    /** @type {HTMLElement} */
    #container;
    /** @type {string} */
    #color = '#2aa198';
    /** @type {ResizeObserver} */
    #resizeObs = null;
    /** @type {Function|null} */
    #lastPlot = null;
    /** @type {'canvas'|'svg'} */
    #activeMode = 'canvas';

    /**
     * @param {HTMLElement} container
     * @param {{ color?: string }} opts
     */
    constructor(container, opts = {}) {
        this.#container = container;
        this.#color = opts.color ?? '#2aa198';

        // Canvas (for plotFunction / plotPoints)
        this.#canvas = document.createElement('canvas');
        this.#canvas.className = 'cell-preview-canvas';
        container.appendChild(this.#canvas);
        this.#ctx = this.#canvas.getContext('2d');

        // SVG (for plotSchematic) — created lazily but reused
        this.#svg = null;

        this.#resizeObs = createRafResizeObserver(() => {
            this.#syncSize();
            this.#lastPlot?.();
        });
        this.#resizeObs.observe(this.#container);
        this.#syncSize();
    }

    setColor(color) {
        this.#color = color;
        this.#lastPlot?.();
    }

    /**
     * Plot a continuous function y = fn(x).
     * @param {(x: number) => number} fn
     * @param {{ xMin?: number, xMax?: number, yMin?: number, yMax?: number }} range
     */
    plotFunction(fn, range = {}) {
        this.#showCanvas();
        this.#lastPlot = () => this.#drawFunction(fn, range);
        this.#lastPlot();
    }

    /**
     * Plot a set of discrete points with linear interpolation.
     * @param {Array<{x: number, y: number}>} points — sorted by x
     * @param {{ interpolation?: 'linear'|'step' }} opts
     */
    plotPoints(points, opts = {}) {
        this.#showCanvas();
        this.#lastPlot = () => this.#drawPoints(points, opts);
        this.#lastPlot();
    }

    /**
     * Draw a schematic SVG diagram (block diagram for PID, delay, latch, etc.)
     * The callback receives (svg: SvgSchematic, w, h, color).
     *
     * @param {(svg: SvgSchematic, w: number, h: number, color: string) => void} drawFn
     * @param {{ height?: number }} [opts] — optional explicit height in CSS px
     *        (overrides the default 80px; the SVG element is resized to match)
     */
    plotSchematic(drawFn, opts = {}) {
        this.#showSvg();
        this.#lastPlot = () => {
            const rect = this.#container.getBoundingClientRect();
            const w = rect.width || this.#canvas.getBoundingClientRect().width;
            const h = opts.height ?? (rect.height || 80);
            if (opts.height) this.#svg.style.height = `${opts.height}px`;
            this.#svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
            // Clear previous content
            while (this.#svg.firstChild) this.#svg.removeChild(this.#svg.firstChild);
            drawFn(new SvgSchematic(this.#svg), w, h, this.#color);
        };
        this.#lastPlot();
    }

    dispose() {
        this.#resizeObs?.disconnect();
        this.#canvas?.remove();
        this.#svg?.remove();
        this.#lastPlot = null;
    }

    // ─── Mode switching ──────────────────────────────────────

    #ensureSvg() {
        if (this.#svg) return;
        this.#svg = document.createElementNS(NS, 'svg');
        this.#svg.classList.add('cell-preview-canvas');
        this.#svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        this.#container.appendChild(this.#svg);
    }

    #showCanvas() {
        if (this.#activeMode === 'canvas') return;
        this.#activeMode = 'canvas';
        this.#canvas.style.display = '';
        if (this.#svg) this.#svg.style.display = 'none';
    }

    #showSvg() {
        this.#ensureSvg();
        if (this.#activeMode === 'svg') return;
        this.#activeMode = 'svg';
        this.#canvas.style.display = 'none';
        this.#svg.style.display = '';
    }

    // ─── Canvas internals ────────────────────────────────────

    #syncSize() {
        const rect = this.#canvas.getBoundingClientRect();
        const w = Math.round(rect.width * dpr());
        const h = Math.round(rect.height * dpr());
        if (this.#canvas.width !== w || this.#canvas.height !== h) {
            this.#canvas.width = w;
            this.#canvas.height = h;
        }
    }

    #logicalSize() {
        return {
            width: this.#canvas.width / dpr(),
            height: this.#canvas.height / dpr(),
        };
    }

    #clear() {
        const ctx = this.#ctx;
        ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
        const { width: w, height: h } = this.#logicalSize();
        ctx.clearRect(0, 0, w, h);
    }

    #drawFunction(fn, range) {
        const { width: w, height: h } = this.#logicalSize();
        if (w < 10 || h < 10) return;
        this.#clear();
        const ctx = this.#ctx;
        const pad = 8;
        const pw = w - pad * 2;
        const ph = h - pad * 2;

        const xMin = range.xMin ?? 0;
        const xMax = range.xMax ?? 10;
        const steps = Math.min(pw * 2, 400);

        // Sample the function
        const samples = [];
        for (let i = 0; i <= steps; i++) {
            const x = xMin + (xMax - xMin) * (i / steps);
            let y = fn(x);
            if (!isFinite(y)) y = 0;
            samples.push({ x, y });
        }

        // Auto-range Y if not specified
        let yMin = range.yMin, yMax = range.yMax;
        if (yMin == null || yMax == null) {
            const ys = samples.map(s => s.y);
            const autoMin = Math.min(...ys);
            const autoMax = Math.max(...ys);
            const margin = (autoMax - autoMin) * 0.1 || 0.5;
            if (yMin == null) yMin = autoMin - margin;
            if (yMax == null) yMax = autoMax + margin;
        }

        // Draw grid lines
        this.#drawGrid(ctx, pad, pw, ph, xMin, xMax, yMin, yMax);

        // Draw function curve
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
            const sx = pad + (samples[i].x - xMin) / (xMax - xMin) * pw;
            const sy = pad + (1 - (samples[i].y - yMin) / (yMax - yMin)) * ph;
            if (i === 0) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
        }
        ctx.strokeStyle = this.#color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Subtle glow
        ctx.strokeStyle = this.#color + '40';
        ctx.lineWidth = 5;
        ctx.stroke();
    }

    #drawPoints(points, opts) {
        const { width: w, height: h } = this.#logicalSize();
        if (w < 10 || h < 10 || points.length === 0) return;
        this.#clear();
        const ctx = this.#ctx;
        const pad = 8;
        const pw = w - pad * 2;
        const ph = h - pad * 2;
        const isStep = opts.interpolation === 'step';

        const xs = points.map(p => p.x);
        const ys = points.map(p => p.y);
        const xMin = Math.min(...xs);
        const xMax = Math.max(...xs);
        const autoMin = Math.min(...ys);
        const autoMax = Math.max(...ys);
        const yMargin = (autoMax - autoMin) * 0.15 || 0.5;
        const yMin = autoMin - yMargin;
        const yMax = autoMax + yMargin;
        const xRange = xMax - xMin || 1;
        const yRange = yMax - yMin || 1;

        this.#drawGrid(ctx, pad, pw, ph, xMin, xMax, yMin, yMax);

        // Draw line
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
            const sx = pad + (points[i].x - xMin) / xRange * pw;
            const sy = pad + (1 - (points[i].y - yMin) / yRange) * ph;
            if (i === 0) {
                ctx.moveTo(sx, sy);
            } else if (isStep) {
                const prevSy = pad + (1 - (points[i - 1].y - yMin) / yRange) * ph;
                ctx.lineTo(sx, prevSy);
                ctx.lineTo(sx, sy);
            } else {
                ctx.lineTo(sx, sy);
            }
        }
        ctx.strokeStyle = this.#color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Draw dots
        for (const p of points) {
            const sx = pad + (p.x - xMin) / xRange * pw;
            const sy = pad + (1 - (p.y - yMin) / yRange) * ph;
            ctx.beginPath();
            ctx.arc(sx, sy, 3, 0, Math.PI * 2);
            ctx.fillStyle = this.#color;
            ctx.fill();
            ctx.beginPath();
            ctx.arc(sx, sy, 3, 0, Math.PI * 2);
            ctx.strokeStyle = this.#color + '60';
            ctx.lineWidth = 4;
            ctx.stroke();
        }
    }

    #drawGrid(ctx, pad, pw, ph, xMin, xMax, yMin, yMax) {
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;

        // Horizontal grid (3 lines)
        for (let i = 1; i <= 3; i++) {
            const y = pad + (ph * i) / 4;
            ctx.beginPath();
            ctx.moveTo(pad, y);
            ctx.lineTo(pad + pw, y);
            ctx.stroke();
        }

        // Zero line if visible
        if (yMin < 0 && yMax > 0) {
            const zeroY = pad + (1 - (0 - yMin) / (yMax - yMin)) * ph;
            ctx.strokeStyle = 'rgba(255,255,255,0.15)';
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(pad, zeroY);
            ctx.lineTo(pad + pw, zeroY);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }
}
