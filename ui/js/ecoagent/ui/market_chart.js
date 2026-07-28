/**
 * market_chart.js — candlestick price chart + MA overlay + volume pane,
 * plus a cumulative order-book depth chart, for one market.
 *
 * The engine clears each market at most once per tick (a uniform-price
 * batch auction — see markets/matching.py), so there is exactly one price
 * per tick and no intra-tick OHLC to draw from. Candles are therefore
 * built by bucketing consecutive ticks: open/close are the first/last
 * cleared price in the bucket, high/low the extremes, volume the sum.
 * That's the same operation a real feed does turning trade prints into
 * 1-minute bars — here the "prints" are already one-per-tick.
 *
 * Inline SVG, no chart library.
 *
 * Usage:
 *   renderMarketChart(host, { series: [{tick, price, volume}, ...], width, height });
 *   renderDepthChart(host, { buys: [{price, volume}, ...], sells: [...], width, height });
 */

const DEFAULTS = {
    width:   520,
    height:  240,
    padding: { top: 10, right: 60, bottom: 18, left: 48 },
    volumeFrac: 0.26,
    paneGap: 10,
    upColor:     '#4ec9b0',
    downColor:   '#d9886a',
    volumeColor: 'rgba(156, 220, 254, 0.45)',
    // Deliberately NOT upColor/downColor — this marks "current price",
    // not a directional signal, so it shouldn't borrow bullish/bearish
    // color semantics from the candles.
    indicatorColor: '#569cd6',
    maColors: ['#e5c07b', '#c586c0'],
    maWindows: [5, 20],
    targetCandles: 50,
};

function bucketCandles(series, targetCount) {
    const n = series.length;
    const bucketSize = Math.max(1, Math.ceil(n / targetCount));
    const candles = [];
    for (let i = 0; i < n; i += bucketSize) {
        const chunk = series.slice(i, i + bucketSize);
        const finite = chunk.filter((p) => Number.isFinite(Number(p.price)));
        const volume = chunk.reduce((s, p) => s + (Number(p.volume) || 0), 0);
        const tick = chunk[chunk.length - 1].tick;
        if (finite.length === 0) {
            candles.push({ tick, open: null, close: null, high: null, low: null, volume });
            continue;
        }
        const prices = finite.map((p) => Number(p.price));
        candles.push({
            tick,
            open:  Number(finite[0].price),
            close: Number(finite[finite.length - 1].price),
            high:  Math.max(...prices),
            low:   Math.min(...prices),
            volume,
        });
    }
    return candles;
}

// Simple moving average over candle closes. Walks backward from each
// candle collecting the last `window` *finite* closes (skipping gap
// candles) rather than a fixed index span, so a run of no-clear ticks
// doesn't stretch the average's effective window.
function computeSMA(candles, window) {
    const closes = candles.map((c) => c.close);
    const out = new Array(candles.length).fill(null);
    for (let i = 0; i < candles.length; i++) {
        if (closes[i] == null) continue;
        const slice = [];
        for (let j = i; j >= 0 && slice.length < window; j--) {
            if (closes[j] != null) slice.push(closes[j]);
        }
        if (slice.length === window) {
            out[i] = slice.reduce((s, v) => s + v, 0) / window;
        }
    }
    return out;
}

// Linear-interpolated quantile over an ascending-sorted array.
function quantile(sorted, q) {
    if (sorted.length === 0) return NaN;
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    return sorted[base + 1] !== undefined
        ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
        : sorted[base];
}

// Outlier-robust price bounds: a single spike (e.g. a startup transient
// on tick 0-1) shouldn't stretch the axis so far that every other candle
// flattens to a hairline. Past a handful of candles, clip to the 2nd/98th
// percentile of highs+lows instead of literal min/max — a few extreme
// wicks draw off-pane (the SVG clips to its own viewport) rather than
// compressing everything else.
function robustPriceBounds(highs, lows) {
    const all = [...highs, ...lows].sort((a, b) => a - b);
    if (all.length < 12) {
        return { min: Math.min(...all), max: Math.max(...all) };
    }
    return { min: quantile(all, 0.02), max: quantile(all, 0.98) };
}

function polylinePieces(values, xToPx) {
    const pieces = [];
    let current = [];
    values.forEach((v, i) => {
        if (v == null || !Number.isFinite(v)) {
            if (current.length > 0) { pieces.push(current); current = []; }
            return;
        }
        current.push([xToPx(i), v]);
    });
    if (current.length > 0) pieces.push(current);
    return pieces;
}

export function renderMarketChart(host, opts) {
    const {
        series = [],
        width  = DEFAULTS.width,
        height = DEFAULTS.height,
        padding = DEFAULTS.padding,
        upColor = DEFAULTS.upColor,
        downColor = DEFAULTS.downColor,
        volumeColor = DEFAULTS.volumeColor,
        indicatorColor = DEFAULTS.indicatorColor,
        maColors = DEFAULTS.maColors,
        maWindows = DEFAULTS.maWindows,
        targetCandles = DEFAULTS.targetCandles,
        volumeFrac = DEFAULTS.volumeFrac,
        paneGap = DEFAULTS.paneGap,
    } = opts || {};

    if (!Array.isArray(series) || series.length === 0) {
        host.innerHTML = '<div class="ea-chart__empty">No history yet — run the world to populate.</div>';
        return;
    }
    if (!series.some((p) => Number.isFinite(Number(p.price)))) {
        host.innerHTML = '<div class="ea-chart__empty">No trades cleared yet on this market.</div>';
        return;
    }

    const candles = bucketCandles(series, targetCandles);
    const mas = maWindows.map((w) => computeSMA(candles, w));

    const highs = candles.map((c) => c.high).filter(Number.isFinite);
    const lows  = candles.map((c) => c.low).filter(Number.isFinite);
    const maValues = mas.flat().filter((v) => v != null);
    const bounds = robustPriceBounds(highs, lows);
    let priceMin = Math.min(bounds.min, ...maValues);
    let priceMax = Math.max(bounds.max, ...maValues);
    if (priceMin === priceMax) {
        const eps = Math.abs(priceMin) * 0.1 || 1;
        priceMin -= eps; priceMax += eps;
    } else {
        const m = (priceMax - priceMin) * 0.08;
        priceMin -= m; priceMax += m;
    }
    const volMax = Math.max(1e-9, ...candles.map((c) => c.volume)) * 1.15;

    const innerW = width - padding.left - padding.right;
    const priceH  = Math.round((height - padding.top - padding.bottom - paneGap) * (1 - volumeFrac));
    const volH    = (height - padding.top - padding.bottom - paneGap) - priceH;
    const priceTop = padding.top;
    const volTop   = padding.top + priceH + paneGap;

    const slot = innerW / candles.length;
    const bodyW = Math.max(2, Math.min(14, slot * 0.62));
    const xToPx = (i) => padding.left + (i + 0.5) * slot;
    const priceToPx = (p) =>
        priceTop + (1 - (p - priceMin) / Math.max(1e-9, (priceMax - priceMin))) * priceH;
    const volToPx = (v) => volTop + volH - (v / volMax) * volH;

    // Candles: wick + body, colored by close-vs-open direction.
    const candleEls = candles.map((c, i) => {
        if (c.open == null) return '';
        const cx = xToPx(i);
        const up = c.close >= c.open;
        const color = up ? upColor : downColor;
        const yHigh = priceToPx(c.high);
        const yLow  = priceToPx(c.low);
        const yOpen  = priceToPx(c.open);
        const yClose = priceToPx(c.close);
        const bodyTop = Math.min(yOpen, yClose);
        const bodyH   = Math.max(1, Math.abs(yClose - yOpen));
        return `
            <line class="ea-mc__wick" x1="${cx}" x2="${cx}" y1="${yHigh}" y2="${yLow}" stroke="${color}" />
            <rect class="ea-mc__body" x="${cx - bodyW / 2}" y="${bodyTop}" width="${bodyW}" height="${bodyH}" fill="${color}" />
        `;
    }).join('');

    // Volume bars, colored to match each candle's direction.
    const volEls = candles.map((c, i) => {
        if (c.volume <= 0) return '';
        const cx = xToPx(i);
        const color = c.open == null ? volumeColor : (c.close >= c.open ? upColor : downColor);
        const y = volToPx(c.volume);
        return `<rect class="ea-mc__vol-bar" x="${cx - bodyW / 2}" y="${y}" width="${bodyW}"
                      height="${volTop + volH - y}" fill="${color}" opacity="${c.open == null ? 1 : 0.55}" />`;
    }).join('');

    // Moving-average overlays.
    const maEls = mas.map((values, idx) => {
        const color = maColors[idx % maColors.length];
        const pieces = polylinePieces(values, xToPx).map((pts) => pts.map(([x, v]) => `${x},${priceToPx(v)}`));
        return pieces.map((pts) => `<polyline class="ea-mc__ma" stroke="${color}" points="${pts.join(' ')}" />`).join('');
    }).join('');
    const maLegend = maWindows.map((w, idx) => {
        const values = mas[idx];
        let last = null;
        for (let i = values.length - 1; i >= 0; i--) { if (values[i] != null) { last = values[i]; break; } }
        const color = maColors[idx % maColors.length];
        return `<tspan fill="${color}">MA${w} ${last != null ? last.toFixed(2) : '—'}</tspan>`;
    });

    // Last-price indicator — dashed line + label, price pane only.
    let lastClose = null;
    for (let i = candles.length - 1; i >= 0; i--) { if (candles[i].close != null) { lastClose = candles[i].close; break; } }
    let indicator = '';
    if (lastClose !== null) {
        const y = priceToPx(lastClose);
        const label = lastClose.toFixed(2);
        // Filled tag (not bare text) on the right axis — square corners
        // per house style (no rounded chrome), solid indicatorColor fill,
        // so the current price reads as a flag the way exchange charts
        // do rather than getting lost among the axis tick labels.
        const tagW = label.length * 6 + 8;
        indicator = `
            <line class="ea-mc__indicator" x1="${padding.left}" x2="${padding.left + innerW}"
                  y1="${y}" y2="${y}" stroke="${indicatorColor}" />
            <rect class="ea-mc__indicator-tag" x="${padding.left + innerW + 2}" y="${y - 7}"
                  width="${tagW}" height="14" fill="${indicatorColor}" />
            <text class="ea-mc__indicator-label" x="${padding.left + innerW + 2 + tagW / 2}" y="${y + 3}"
                  text-anchor="middle">${label}</text>
        `;
    }

    // Axis ticks.
    const yTicks = 4;
    const priceTicks = [];
    for (let i = 0; i <= yTicks; i++) {
        const frac = i / yTicks;
        const pv = priceMin + frac * (priceMax - priceMin);
        const yp = priceTop + (1 - frac) * priceH;
        priceTicks.push(`<text class="ea-mc__y-label ea-mc__y-label--left" x="${padding.left - 6}" y="${yp + 3}">${pv.toFixed(2)}</text>`);
    }
    const volTicks = [0, 1].map((i) => {
        const frac = i;
        const vv = frac * volMax;
        const yp = volTop + (1 - frac) * volH;
        return `<text class="ea-mc__y-label ea-mc__y-label--left" x="${padding.left - 6}" y="${yp + 3}">${vv.toFixed(0)}</text>`;
    }).join('');
    const xTickCount = Math.min(6, candles.length - 1);
    const xTicks = [];
    for (let i = 0; i <= xTickCount; i++) {
        const idx = Math.round((i / Math.max(1, xTickCount)) * (candles.length - 1));
        const px = xToPx(idx);
        xTicks.push(`<text class="ea-mc__x-label" x="${px}" y="${volTop + volH + 14}">${candles[idx].tick}</text>`);
    }

    host.innerHTML = `
        <svg class="ea-mc" width="${width}" height="${height}"
             viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
            <g class="ea-mc__grid">
                <line x1="${padding.left}" y1="${priceTop}" x2="${padding.left}" y2="${priceTop + priceH}" />
                <line x1="${padding.left}" y1="${priceTop + priceH}" x2="${padding.left + innerW}" y2="${priceTop + priceH}" />
                <line x1="${padding.left}" y1="${volTop}" x2="${padding.left}" y2="${volTop + volH}" />
                <line x1="${padding.left}" y1="${volTop + volH}" x2="${padding.left + innerW}" y2="${volTop + volH}" />
            </g>
            <g class="ea-mc__vol-bars">${volEls}</g>
            <g class="ea-mc__candles">${candleEls}</g>
            ${maEls}
            ${indicator}
            <g class="ea-mc__y-axis">${priceTicks.join('')}${volTicks}</g>
            <g class="ea-mc__x-axis">${xTicks.join('')}</g>
            <text class="ea-mc__legend" x="${padding.left}" y="${priceTop - 2}">${maLegend.join('<tspan dx="10"> </tspan>')}</text>
            <text class="ea-mc__axis-title" x="${padding.left}" y="${volTop - 2}">volume</text>
        </svg>
    `;
}

/**
 * Cumulative depth chart from the market's last order-book snapshot
 * (see `market_orderbook` — full resting book, not top-of-book only).
 * X axis is price; Y axis is cumulative volume from the touch outward,
 * bids filling left of the spread, asks filling right — the standard
 * "Depth" tab layout on exchange UIs.
 */
export function renderDepthChart(host, opts) {
    const {
        buys = [], sells = [],
        width  = DEFAULTS.width,
        height = DEFAULTS.height,
        padding = { top: 10, right: 16, bottom: 18, left: 48 },
        buyColor  = DEFAULTS.upColor,
        sellColor = DEFAULTS.downColor,
    } = opts || {};

    if (buys.length === 0 && sells.length === 0) {
        host.innerHTML = '<div class="ea-chart__empty">Order book is empty — no resting orders this tick.</div>';
        return;
    }

    // buys arrive best-first (highest price first); sells best-first
    // (lowest price first). Build cumulative steps outward from the touch.
    const buySteps = [];
    let running = 0;
    for (const o of buys) {
        running += Number(o.volume) || 0;
        buySteps.push({ price: Number(o.price), cum: running });
    }
    const sellSteps = [];
    running = 0;
    for (const o of sells) {
        running += Number(o.volume) || 0;
        sellSteps.push({ price: Number(o.price), cum: running });
    }

    const prices = [...buySteps, ...sellSteps].map((s) => s.price);
    const priceMin = Math.min(...prices);
    const priceMax = Math.max(...prices);
    const priceSpan = Math.max(1e-9, priceMax - priceMin);
    const cumMax = Math.max(1e-9, ...buySteps.map((s) => s.cum), ...sellSteps.map((s) => s.cum));

    const innerW = width - padding.left - padding.right;
    const innerH = height - padding.top - padding.bottom;
    const priceToPx = (p) => padding.left + ((p - priceMin) / priceSpan) * innerW;
    const cumToPx = (v) => padding.top + (1 - v / cumMax) * innerH;
    const baseline = padding.top + innerH;

    // Buys step outward (descending price) from the touch leftward; sells
    // step outward (ascending price) from the touch rightward. Each is
    // drawn as a filled step-area anchored to the axis baseline.
    const buyPts = buySteps.map((s) => `${priceToPx(s.price)},${cumToPx(s.cum)}`);
    const sellPts = sellSteps.map((s) => `${priceToPx(s.price)},${cumToPx(s.cum)}`);
    const stepArea = (steps, ascending) => {
        if (steps.length === 0) return '';
        const ordered = ascending ? steps : steps.slice().reverse();
        const pts = [];
        // Start at the axis baseline under the first (touch-nearest) point.
        pts.push(`${priceToPx(ordered[0].price)},${baseline}`);
        for (let i = 0; i < ordered.length; i++) {
            const { price, cum } = ordered[i];
            pts.push(`${priceToPx(price)},${cumToPx(cum)}`);
            const next = ordered[i + 1];
            if (next) pts.push(`${priceToPx(next.price)},${cumToPx(cum)}`);
        }
        pts.push(`${priceToPx(ordered[ordered.length - 1].price)},${baseline}`);
        return pts.join(' ');
    };
    const buyArea  = stepArea(buySteps, false);
    const sellArea = stepArea(sellSteps, true);

    const yTicks = 4;
    const yLabels = [];
    for (let i = 0; i <= yTicks; i++) {
        const frac = i / yTicks;
        const yp = padding.top + (1 - frac) * innerH;
        yLabels.push(`<text class="ea-mc__y-label ea-mc__y-label--left" x="${padding.left - 6}" y="${yp + 3}">${(frac * cumMax).toFixed(0)}</text>`);
    }
    const xTickCount = 4;
    const xLabels = [];
    for (let i = 0; i <= xTickCount; i++) {
        const frac = i / xTickCount;
        const pv = priceMin + frac * priceSpan;
        const xp = padding.left + frac * innerW;
        xLabels.push(`<text class="ea-mc__x-label" x="${xp}" y="${padding.top + innerH + 14}">${pv.toFixed(2)}</text>`);
    }

    host.innerHTML = `
        <svg class="ea-mc ea-mc--depth" width="${width}" height="${height}"
             viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
            <g class="ea-mc__grid">
                <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${baseline}" />
                <line x1="${padding.left}" y1="${baseline}" x2="${padding.left + innerW}" y2="${baseline}" />
            </g>
            ${buyArea  ? `<polygon class="ea-mc__depth-area" points="${buyArea}" fill="${buyColor}" fill-opacity="0.22" />` : ''}
            ${sellArea ? `<polygon class="ea-mc__depth-area" points="${sellArea}" fill="${sellColor}" fill-opacity="0.22" />` : ''}
            ${buyPts.length  ? `<polyline class="ea-mc__depth-line" points="${buyPts.join(' ')}" stroke="${buyColor}" />` : ''}
            ${sellPts.length ? `<polyline class="ea-mc__depth-line" points="${sellPts.join(' ')}" stroke="${sellColor}" />` : ''}
            <g class="ea-mc__y-axis">${yLabels.join('')}</g>
            <g class="ea-mc__x-axis">${xLabels.join('')}</g>
            <text class="ea-mc__axis-title" x="${padding.left}" y="${padding.top - 2}">cumulative depth</text>
        </svg>
    `;
}
