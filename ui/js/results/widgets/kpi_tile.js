/**
 * kpi_tile.js
 *
 * Big-number KPI tile. Shows the latest value of a variable and the delta vs.
 * a configurable baseline year.  Designed for "one metric, one story" framing
 * on dashboards.
 *
 * Config:
 *   variable       string   Variable name (namespace-prefixed or bare)
 *   label          string   Override label (falls back to variable name)
 *   baselineYear   number   Year used for the comparison (default: first year)
 *   format         enum     'number' | 'percent' | 'currency' | 'rate' | 'eur'
 *   decimals       number   Decimal places (default 1)
 *   prefix         string   Optional prefix (e.g. '€')
 *   suffix         string   Optional suffix (e.g. '%')
 *   scale          number   Multiplier applied before formatting (default 1)
 *   invertDelta    boolean  If true, negative change shows green (for metrics
 *                            where lower is better, e.g. unemployment)
 *   goodAbove      number   Optional threshold; value above is rendered green
 *   badAbove       number   Optional threshold; value above is rendered red
 */

import { TileBase } from '../tile_base.js';
import { registerWidget } from '../tile_registry.js';

export class KpiTile extends TileBase {
    static TYPE = 'kpi';
    static TITLE = 'KPI';
    static ICON = 'trending_up';
    static DESCRIPTION = 'Single-number KPI with delta vs baseline year';
    static DEFAULT_SIZE = { w: 3, h: 2 };
    static SIZE_CONSTRAINTS = { minW: 2, minH: 2, maxW: 6, maxH: 4 };
    static EXPANDABLE = false;

    getDefaultConfig() {
        return {
            variable: '',
            label: '',
            baselineYear: null,
            format: 'number',
            decimals: 1,
            prefix: '',
            suffix: '',
            scale: 1,
            invertDelta: false,
            goodAbove: null,
            badAbove: null,
        };
    }

    getConfigSchema() {
        return {
            fields: [
                { key: 'variable', type: 'variable', label: 'Variable' },
                { key: 'label', type: 'text', label: 'Label override', description: 'Falls back to variable name' },
                { key: 'baselineYear', type: 'number', label: 'Baseline year', description: 'Empty = first year in series' },
                { key: 'format', type: 'select', label: 'Format',
                  options: [
                      { value: 'number', label: 'Number' },
                      { value: 'percent', label: 'Percent (×100, %)' },
                      { value: 'rate', label: 'Rate (×100, pp)' },
                      { value: 'currency', label: 'Currency (€)' },
                      { value: 'eur', label: 'EUR bn' },
                  ] },
                { key: 'decimals', type: 'number', label: 'Decimals' },
                { key: 'prefix', type: 'text', label: 'Prefix' },
                { key: 'suffix', type: 'text', label: 'Suffix' },
                { key: 'scale', type: 'number', label: 'Scale (multiplier)' },
                { key: 'invertDelta', type: 'checkbox', label: 'Invert delta coloring', description: 'Use for "lower is better" metrics' },
            ],
        };
    }

    render(data) {
        if (!this.contentElement) return;
        if (!data) { this.showEmpty('No data'); return; }

        const resolved = this.resolveVariable(data, 'variable');
        if (!resolved) { this.showEmpty('No variables'); return; }
        const { varData, varName } = resolved;

        const values = Array.isArray(varData) ? varData : (varData.mean ?? varData.p50 ?? []);
        const time = data.time ?? [];
        if (!values?.length || !time?.length) { this.showEmpty('No data'); return; }

        const latest = this.#lastFinite(values);
        const baselineIdx = this.#findBaselineIndex(time);
        const baseline = Number.isFinite(values[baselineIdx]) ? values[baselineIdx] : null;

        const cfg = this.config;
        const scaledLatest = latest != null ? latest * (cfg.scale || 1) : null;
        const scaledBaseline = baseline != null ? baseline * (cfg.scale || 1) : null;

        const deltaAbs = (scaledLatest != null && scaledBaseline != null)
            ? (scaledLatest - scaledBaseline) : null;
        const deltaPct = (deltaAbs != null && Math.abs(scaledBaseline) > 1e-12)
            ? (deltaAbs / Math.abs(scaledBaseline)) : null;

        // Color logic
        let valueColor = 'inherit';
        if (Number.isFinite(cfg.badAbove) && scaledLatest != null && scaledLatest > cfg.badAbove) valueColor = '#e55353';
        else if (Number.isFinite(cfg.goodAbove) && scaledLatest != null && scaledLatest > cfg.goodAbove) valueColor = '#2ecc71';

        const deltaSign = deltaAbs == null ? 0 : Math.sign(deltaAbs);
        const goodDirection = cfg.invertDelta ? -1 : 1;
        const deltaColor = deltaSign === 0 ? 'rgba(255,255,255,0.55)'
            : deltaSign === goodDirection ? '#2ecc71' : '#e55353';
        const deltaArrow = deltaSign > 0 ? '▲' : deltaSign < 0 ? '▼' : '■';

        const label = cfg.label || this.formatLabel(varName);
        const baselineYearUsed = Math.round(time[baselineIdx]);
        const latestYear = Math.round(time[time.length - 1]);

        this.contentElement.innerHTML = `
            <div class="kpi-tile" style="display:flex;flex-direction:column;justify-content:center;align-items:flex-start;height:100%;padding:10px 14px;gap:4px;">
                <div class="kpi-label" style="color:rgba(255,255,255,0.6);font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">${this.#esc(label)}</div>
                <div class="kpi-value" style="color:${valueColor};font-size:36px;font-weight:600;line-height:1.1;">
                    ${this.#formatValue(scaledLatest, cfg)}
                </div>
                <div class="kpi-delta" style="color:${deltaColor};font-size:12px;">
                    ${deltaAbs == null ? '—' : `${deltaArrow} ${this.#formatDelta(deltaAbs, deltaPct, cfg)}`}
                    <span style="color:rgba(255,255,255,0.4);margin-left:6px;">vs ${baselineYearUsed}</span>
                </div>
                <div class="kpi-year" style="color:rgba(255,255,255,0.3);font-size:10px;margin-top:2px;">${latestYear}</div>
            </div>
        `;
        this.setTitle(label);
    }

    #lastFinite(arr) {
        for (let i = arr.length - 1; i >= 0; i--) {
            if (Number.isFinite(arr[i])) return arr[i];
        }
        return null;
    }

    #findBaselineIndex(time) {
        const target = this.config.baselineYear;
        if (target == null || target === '') return 0;
        const t = Number(target);
        if (!Number.isFinite(t)) return 0;
        let bestIdx = 0;
        let bestDiff = Infinity;
        for (let i = 0; i < time.length; i++) {
            const diff = Math.abs(time[i] - t);
            if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
        }
        return bestIdx;
    }

    #formatValue(v, cfg) {
        if (v == null || !Number.isFinite(v)) return '—';
        const decimals = cfg.decimals ?? 1;
        switch (cfg.format) {
            case 'percent': return `${cfg.prefix || ''}${(v * 100).toFixed(decimals)}%${cfg.suffix || ''}`;
            case 'rate':    return `${cfg.prefix || ''}${(v * 100).toFixed(decimals)} pp${cfg.suffix || ''}`;
            case 'currency':return `€${this.#formatNumberCompact(v, decimals)}${cfg.suffix || ''}`;
            case 'eur':     return `€${v.toFixed(decimals)} bn${cfg.suffix || ''}`;
            default:        return `${cfg.prefix || ''}${this.#formatNumberCompact(v, decimals)}${cfg.suffix || ''}`;
        }
    }

    #formatDelta(abs, pct, cfg) {
        const decimals = cfg.decimals ?? 1;
        const absStr = cfg.format === 'percent' || cfg.format === 'rate'
            ? `${(abs * 100).toFixed(decimals)} pp`
            : this.#formatValue(abs, { ...cfg, prefix: '', suffix: '' });
        const pctStr = pct == null ? '' : ` (${(pct * 100).toFixed(0)}%)`;
        return `${absStr}${pctStr}`;
    }

    #formatNumberCompact(v, decimals) {
        const abs = Math.abs(v);
        if (abs >= 1e12) return (v / 1e12).toFixed(decimals) + 'T';
        if (abs >= 1e9)  return (v / 1e9).toFixed(decimals) + 'B';
        if (abs >= 1e6)  return (v / 1e6).toFixed(decimals) + 'M';
        if (abs >= 1e3)  return (v / 1e3).toFixed(decimals) + 'k';
        return v.toFixed(decimals);
    }

    #esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({
            '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
        }[c]));
    }
}

registerWidget(KpiTile);
