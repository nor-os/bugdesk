/**
 * calibration_tab.js — Calibration + ETL workspace tab.
 *
 * Two sections behind a sub-tab strip in the detail header:
 *   • Calibrate — author a *.calibration.json (parameters, targets, settings),
 *     run the fit, watch convergence, apply fitted params as a scenario. A
 *     `reference` target PICKS from the ETL-produced series (the link).
 *   • Reference data — a node-DAG ETL editor over the ported providers
 *     (FRED/OWID/World Bank/OECD/WID + CSV/inline) and transform library, with
 *     schema-driven per-node config (node_config_form), per-node preview, and
 *     presets. Sinks write the reference series the Calibrate side consumes.
 *
 * Backed by the Bridge calibration + etl methods. See docs/CALIBRATION_AND_ETL.md.
 */

import { esc } from './_util.js';
import { renderLineChart } from '../ui/charts.js';
import { toastError } from '../ui/toast.js';
import { renderNodeConfigForm } from '../ui/node_config_form.js';

const POLL_MS = 500;
const STATISTICS = ['mean', 'last', 'std', 'cv', 'min', 'max', 'range'];
const METHODS = ['differential-evolution', 'nelder-mead'];

export function makeCalibrationTab(hostEl, calibrationId, ctx) {
    return new CalibrationTab(hostEl, calibrationId, ctx);
}

const blankSpec = (id) => ({
    id: id || '', name: '', parameters: [], targets: [],
    settings: { method: 'differential-evolution', ticks: 120, warmup: 20, seed: 0, max_iterations: 20, popsize: 8, workers: 1 },
});
let _seq = 0;
const nid = () => `n${++_seq}`;

class CalibrationTab {
    constructor(hostEl, calibrationId, { logger, eventBus } = {}) {
        this.hostEl = hostEl;
        this.logger = logger ?? { warn() {}, info() {} };
        this.eventBus = eventBus ?? null;
        // A `.pipeline.json` file routes here as entityId `etl:<id>` → open the
        // Reference-data editor on that pipeline; a plain id is a calibration.
        this._pendingPipelineId = null;
        if (typeof calibrationId === 'string' && calibrationId.startsWith('etl:')) {
            this._pendingPipelineId = calibrationId.slice(4);
            this.calibrationId = null;
            this._section = 'reference';
        } else {
            this.calibrationId = calibrationId || null;
            this._section = 'calibrate';
        }
        this._poll = null;
        this._spec = null; this._dirty = false; this._lastResult = null;
        this._paramOpts = []; this._targetOpts = { markets: [], kpis: [] };
        this._refSeries = []; this._nodeDefs = {};
        this._graph = null; this._sel = null; this._nodePreview = {};
        this._pendingRefTarget = null;   // {targetIndex} to pre-bind a built series
    }

    get api() { return window.pywebview?.api; }

    async mount() {
        this.hostEl.innerHTML = `
            <div class="ea-calib">
                <header class="ea-detail-header">
                    <nav class="ea-calib__tabs">
                        <button class="ea-calib__tab is-on" data-section="calibrate">Calibrate</button>
                        <button class="ea-calib__tab" data-section="reference">Reference data</button>
                    </nav>
                    <span class="ea-detail-header__spacer"></span>
                    <span class="ea-calib__hint" data-role="header-hint"></span>
                </header>
                <div class="ea-calib__body" data-role="body"></div>
            </div>`;
        this._root = this.hostEl.querySelector('.ea-calib');
        this._root.querySelectorAll('[data-section]').forEach((b) => {
            b.addEventListener('click', () => this._switchSection(b.dataset.section));
            b.classList.toggle('is-on', b.dataset.section === this._section);
        });
        try {
            const [po, to, sl, refs] = await Promise.all([
                this.api?.calibration_param_options?.(), this.api?.calibration_target_options?.(),
                this.api?.etl_source_list?.(), this.api?.etl_reference_list?.()]);
            this._paramOpts = po?.params || [];
            this._targetOpts = { markets: to?.markets || [], kpis: to?.kpis || [] };
            this._nodeDefs = sl?.nodeDefs || {};
            this._refSeries = refs?.series || [];
        } catch (err) { this.logger.warn?.('option load failed', { err }); }
        await this._renderSection();
    }

    dispose() { this._stopPoll(); }
    _stopPoll() { if (this._poll) { clearInterval(this._poll); this._poll = null; } }
    _body() { return this._root.querySelector('[data-role="body"]'); }
    // Tell the left-rail file tree a non-entity project file changed so the new
    // calibration / pipeline appears immediately.
    _notifyProject() { try { this.eventBus?.emit?.('ecoagent:project:changed', { source: 'calibration' }); } catch { /* ignore */ } }

    _switchSection(section) {
        if (section === this._section) return;
        this._section = section; this._stopPoll();
        this._root.querySelectorAll('[data-section]').forEach((b) => b.classList.toggle('is-on', b.dataset.section === section));
        this._renderSection();
    }
    _renderSection() { return this._section === 'calibrate' ? this._renderCalibrate() : this._renderReference(); }

    async _refreshRefSeries() {
        try { const r = await this.api?.etl_reference_list?.(); this._refSeries = r?.series || []; } catch { /* ignore */ }
    }

    // ═══════════════════════════════════════════════════════════ Calibrate

    async _renderCalibrate() {
        const res = await this.api?.calibrations_list?.();
        const configs = res?.calibrations || [];
        this._body().innerHTML = `
            <div class="ea-calib__split">
                <aside class="ea-calib__side">
                    <div class="ea-calib__side-head"><span>Calibrations</span><button class="ea-btn ea-btn--small" data-action="new">New</button></div>
                    <ul class="ea-calib__list" data-role="config-list">${configs.length ? configs.map((c) => `
                        <li class="ea-calib__item${c.id === this.calibrationId ? ' is-sel' : ''}" data-id="${esc(c.id)}"><span class="ea-calib__item-name">${esc(c.name || c.id)}</span><span class="ea-calib__item-meta">${c.n_parameters}p·${c.n_targets}t</span></li>`).join('') : '<li class="ea-calib__empty">No calibrations yet.</li>'}</ul>
                </aside>
                <section class="ea-calib__main" data-role="editor"><p class="ea-calib__placeholder">Select or create a calibration.</p></section>
            </div>`;
        this._body().querySelector('[data-action="new"]').addEventListener('click', () => this._newConfig());
        this._body().querySelectorAll('.ea-calib__item[data-id]').forEach((li) => li.addEventListener('click', () => this._selectConfig(li.dataset.id)));
        if (this.calibrationId) await this._selectConfig(this.calibrationId);
    }

    _newConfig() { this._stopPoll(); this.calibrationId = null; this._spec = blankSpec(''); this._dirty = true; this._lastResult = null; this._renderEditor(); }

    async _selectConfig(id) {
        this._stopPoll();
        const res = await this.api?.calibration_get?.(id);
        if (!res?.ok) { toastError(`Could not load ${id}`); return; }
        this.calibrationId = id; this._spec = res.calibration;
        this._spec.settings = this._spec.settings || blankSpec(id).settings;
        this._dirty = false; this._lastResult = null; this._renderEditor();
        try {
            const st = await this.api?.calibration_status?.();
            const name = this._spec.name || id;
            if (st?.ok && st.name === name && st.status === 'running') { this._showRunPanel(); this._startPoll(); }
            else if (st?.ok && st.name === name && st.status === 'completed' && st.result) { this._showRunPanel(); this._renderResult(st.result); }
        } catch { /* optional */ }
    }

    _renderEditor() {
        const s = this._spec;
        this._body().querySelector('[data-role="editor"]').innerHTML = `
            <div class="ea-calib__ed-head">
                <input class="ea-calib__title-input" data-bind="name" value="${esc(s.name || '')}" placeholder="Calibration name">
                <code class="ea-calib__id">${esc(s.id || 'unsaved')}</code><span class="ea-detail-header__spacer"></span>
                <button class="ea-btn ea-btn--small" data-action="save">Save</button>
                <button class="ea-btn ea-btn--small ea-btn--primary" data-action="run">Run</button></div>
            <section class="ea-card"><div class="ea-card__head-row"><h3 class="ea-card__title">Parameters</h3><button class="ea-btn ea-btn--small" data-action="add-param">Add</button></div><div class="ea-calib__rows" data-role="params"></div></section>
            <section class="ea-card"><div class="ea-card__head-row"><h3 class="ea-card__title">Targets</h3><button class="ea-btn ea-btn--small" data-action="add-target">Add</button></div><div class="ea-calib__rows" data-role="targets"></div></section>
            <section class="ea-card"><h3 class="ea-card__title">Settings</h3><div class="ea-form-grid" data-role="settings"></div></section>
            <section class="ea-card" data-role="run-panel" hidden><h3 class="ea-card__title">Run</h3><div class="ea-calib__run-status" data-role="run-status"></div><div class="ea-calib__chart" data-role="convergence"></div><div data-role="run-result"></div></section>`;
        const ed = this._body().querySelector('[data-role="editor"]');
        ed.querySelector('[data-bind="name"]').addEventListener('input', (e) => { s.name = e.target.value; this._dirty = true; });
        ed.querySelector('[data-action="save"]').addEventListener('click', () => this._save());
        ed.querySelector('[data-action="run"]').addEventListener('click', () => this._run());
        ed.querySelector('[data-action="add-param"]').addEventListener('click', () => { s.parameters.push({ archetype: '', param: '', min: 0, max: 1, initial: null }); this._dirty = true; this._renderParams(); });
        ed.querySelector('[data-action="add-target"]').addEventListener('click', () => { s.targets.push({ market: '', statistic: 'mean', target: 0, weight: 1 }); this._dirty = true; this._renderTargets(); });
        this._renderParams(); this._renderTargets(); this._renderSettings();
    }

    _archetypes() { return [...new Set(this._paramOpts.map((p) => p.archetype))].sort(); }
    _paramsFor(a) { return this._paramOpts.filter((p) => p.archetype === a); }

    _renderParams() {
        const host = this._body().querySelector('[data-role="params"]'); const archs = this._archetypes();
        host.innerHTML = this._spec.parameters.length ? this._spec.parameters.map((p, i) => `
            <div class="ea-calib__row" data-i="${i}">
                <select data-pf="archetype"><option value="">archetype…</option>${archs.map((a) => `<option value="${esc(a)}"${a === p.archetype ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select>
                <select data-pf="param"><option value="">param…</option>${this._paramsFor(p.archetype).map((o) => `<option value="${esc(o.param)}"${o.param === p.param ? ' selected' : ''}>${esc(o.param)}</option>`).join('')}</select>
                <input type="number" step="any" data-pf="min" value="${p.min ?? ''}" placeholder="min"><input type="number" step="any" data-pf="max" value="${p.max ?? ''}" placeholder="max"><input type="number" step="any" data-pf="initial" value="${p.initial ?? ''}" placeholder="init">
                <button class="ea-btn ea-btn--icon" data-action="rm-param"><span class="material-symbols-outlined">close</span></button></div>`).join('') : '<p class="ea-calib__muted">No parameters — add one to tune.</p>';
        host.querySelectorAll('.ea-calib__row').forEach((row) => {
            const i = Number(row.dataset.i);
            row.querySelectorAll('[data-pf]').forEach((el) => el.addEventListener('change', (e) => {
                const f = e.target.dataset.pf, p = this._spec.parameters[i];
                p[f] = (f === 'archetype' || f === 'param') ? e.target.value : (e.target.value === '' ? (f === 'initial' ? null : 0) : Number(e.target.value));
                this._dirty = true;
                if (f === 'archetype') { p.param = ''; this._renderParams(); }
                else if (f === 'param') { const o = this._paramsFor(p.archetype).find((x) => x.param === e.target.value); if (o) { if (o.min != null) p.min = o.min; if (o.max != null) p.max = o.max; if (p.initial == null) p.initial = o.default; this._renderParams(); } }
            }));
            row.querySelector('[data-action="rm-param"]').addEventListener('click', () => { this._spec.parameters.splice(i, 1); this._dirty = true; this._renderParams(); });
        });
    }

    _renderTargets() {
        const host = this._body().querySelector('[data-role="targets"]'); const o = this._targetOpts;
        const kind = (t) => t.reference ? 'reference' : (t.band ? 'band' : 'point');
        host.innerHTML = this._spec.targets.length ? this._spec.targets.map((t, i) => {
            const sel = t.market || (t.kpi ? `kpi:${t.country || ''}:${t.kpi}` : ''); const k = kind(t);
            const goal = k === 'reference'
                ? `<select data-tf="reference"><option value="">series…</option>${this._refSeries.map((s) => `<option value="${esc(s.series_id)}"${s.series_id === t.reference ? ' selected' : ''}>${esc(s.label || s.series_id)} (${s.n})</option>`).join('')}</select><button class="ea-btn ea-btn--small" data-action="build-ref" data-i="${i}">build new…</button>`
                : k === 'band'
                ? `<input type="number" step="any" data-tf="band0" value="${t.band?.[0] ?? ''}" placeholder="lo"><input type="number" step="any" data-tf="band1" value="${t.band?.[1] ?? ''}" placeholder="hi">`
                : `<select data-tf="statistic">${STATISTICS.map((st) => `<option${st === t.statistic ? ' selected' : ''}>${st}</option>`).join('')}</select><input type="number" step="any" data-tf="target" value="${t.target ?? ''}" placeholder="target">`;
            return `<div class="ea-calib__row" data-i="${i}">
                <select data-tf="observable"><option value="">observable…</option>
                    <optgroup label="markets">${o.markets.map((m) => `<option value="${esc(m)}"${m === t.market ? ' selected' : ''}>${esc(m)}</option>`).join('')}</optgroup>
                    <optgroup label="KPIs">${o.kpis.map((k2) => { const v = `kpi:${k2.country || ''}:${k2.id}`; return `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(k2.label || k2.id)}</option>`; }).join('')}</optgroup></select>
                <select data-tf="kind"><option value="point"${k === 'point' ? ' selected' : ''}>point</option><option value="band"${k === 'band' ? ' selected' : ''}>band</option><option value="reference"${k === 'reference' ? ' selected' : ''}>reference</option></select>
                ${goal}<input type="number" step="any" data-tf="weight" value="${t.weight ?? 1}" placeholder="wt">
                <button class="ea-btn ea-btn--icon" data-action="rm-target"><span class="material-symbols-outlined">close</span></button></div>`;
        }).join('') : '<p class="ea-calib__muted">No targets — add one to fit against.</p>';
        host.querySelectorAll('.ea-calib__row').forEach((row) => {
            const i = Number(row.dataset.i);
            row.querySelectorAll('[data-tf]').forEach((el) => el.addEventListener('change', (e) => this._editTarget(i, e.target.dataset.tf, e.target.value)));
            row.querySelector('[data-action="rm-target"]').addEventListener('click', () => { this._spec.targets.splice(i, 1); this._dirty = true; this._renderTargets(); });
            row.querySelector('[data-action="build-ref"]')?.addEventListener('click', () => this._buildRefFor(i));
        });
    }

    _editTarget(i, field, value) {
        const t = this._spec.targets[i]; this._dirty = true;
        if (field === 'observable') { delete t.market; delete t.kpi; delete t.country; if (value.startsWith('kpi:')) { const [, c, k] = value.split(':'); t.kpi = k; if (c) t.country = c; } else if (value) t.market = value; }
        else if (field === 'kind') { delete t.target; delete t.band; delete t.reference; if (value === 'band') t.band = [0, 1]; else if (value === 'reference') t.reference = ''; else { t.statistic = t.statistic || 'mean'; t.target = 0; } this._renderTargets(); }
        else if (field === 'band0' || field === 'band1') { t.band = t.band || [0, 1]; t.band[field === 'band0' ? 0 : 1] = Number(value); }
        else if (field === 'target' || field === 'weight') t[field] = Number(value);
        else t[field] = value;
    }

    // build-new round trip: ETL→calibration link
    _buildRefFor(targetIndex) {
        this._pendingRefTarget = { targetIndex };
        this._graph = this._newGraph();
        // pre-fill the sink series id with a suggested name
        const sink = this._graph.nodes.find((n) => n.type === 'reference');
        if (sink) sink.config.series_id = `${this.calibrationId || 'series'}_${targetIndex}`;
        this._switchSection('reference');
    }

    _renderSettings() {
        const s = this._spec.settings;
        const num = (k, label) => `<label class="ea-row"><span>${label}</span><input type="number" step="1" data-sf="${k}" value="${s[k] ?? ''}"></label>`;
        this._body().querySelector('[data-role="settings"]').innerHTML = `
            <label class="ea-row"><span>method</span><select data-sf="method">${METHODS.map((m) => `<option${m === s.method ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
            ${num('ticks', 'ticks')}${num('warmup', 'warmup')}${num('seed', 'seed')}${num('max_iterations', 'max iter')}${num('popsize', 'popsize')}${num('workers', 'workers')}`;
        this._body().querySelectorAll('[data-sf]').forEach((el) => el.addEventListener('change', (e) => { const k = e.target.dataset.sf; s[k] = k === 'method' ? e.target.value : Number(e.target.value); this._dirty = true; }));
    }

    async _save() {
        const s = this._spec;
        if (!s.id) s.id = (s.name || 'calibration').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'calibration';
        const res = await this.api?.calibration_save?.(s.id, s);
        if (!res?.ok) { toastError(`Save failed: ${res?.error || ''}`); return; }
        this._dirty = false; this.calibrationId = res.id || s.id; this._notifyProject(); await this._renderCalibrate();
    }
    async _run() {
        if (this._dirty || !this.calibrationId) await this._save();
        this._showRunPanel(); this._setStatus('Starting…');
        const res = await this.api?.calibration_run?.(this.calibrationId);
        if (!res?.ok) { this._setStatus(`Failed to start: ${esc(res?.error || '')}`); return; }
        this._startPoll();
    }
    _showRunPanel() { const p = this._body().querySelector('[data-role="run-panel"]'); if (p) p.hidden = false; }
    _startPoll() { this._stopPoll(); this._poll = setInterval(() => this._pollStatus(), POLL_MS); }
    _setStatus(h) { const e = this._body().querySelector('[data-role="run-status"]'); if (e) e.innerHTML = h; }
    _setResult(h) { const e = this._body().querySelector('[data-role="run-result"]'); if (e) e.innerHTML = h; }

    async _pollStatus() {
        let st; try { st = await this.api?.calibration_status?.(); } catch { return; }
        if (!st?.ok) return;
        const best = st.best == null ? '—' : Number(st.best).toPrecision(4);
        this._setStatus(`<b>${esc(st.status)}</b> · evals ${st.n_eval} · best ${best}`);
        const vals = (st.history || []).filter((v) => v != null && isFinite(v));
        const host = this._body().querySelector('[data-role="convergence"]');
        if (host && vals.length) renderLineChart(host, { height: 120, title: 'best objective', series: [{ points: vals.map((v, i) => [i, v]), color: 'var(--accent-bright)' }] });
        if (st.status === 'completed' || st.status === 'error') { this._stopPoll(); if (st.status === 'completed') this._renderResult(st.result); else this._setResult(`<p class="ea-calib__err">${esc(st.error || 'failed')}</p>`); }
    }

    _renderResult(result) {
        this._lastResult = result; if (!result) { this._setResult(''); return; }
        const rows = Object.entries(result.parameters || {}).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${v == null ? '—' : Number(v).toPrecision(5)}</td></tr>`).join('');
        const fit = (result.target_fit || []).map((f) => `<tr><td>${esc(f.target)}</td><td>${f.observed ?? f.model_mean ?? '—'}</td><td>${Array.isArray(f.goal) ? `[${f.goal.join(', ')}]` : (f.goal ?? f.ref_mean ?? '—')}</td><td>${f.residual ?? f.rmse_norm ?? '—'}</td></tr>`).join('');
        this._setResult(`<p>objective <b>${result.objective == null ? '—' : Number(result.objective).toPrecision(4)}</b> · ${esc(result.message || '')}</p>
            <table class="ea-table"><thead><tr><th>Fitted parameter</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>
            <table class="ea-table"><thead><tr><th>Target</th><th>Observed</th><th>Goal</th><th>Residual</th></tr></thead><tbody>${fit}</tbody></table>
            <div class="ea-calib__apply"><input data-role="apply-id" value="${esc(this.calibrationId || 'calibration')}-fit" placeholder="scenario id"><button class="ea-btn ea-btn--small ea-btn--primary" data-action="apply">Apply as scenario</button></div>`);
        this._body().querySelector('[data-action="apply"]')?.addEventListener('click', () => this._apply());
    }
    async _apply() {
        const sid = this._body().querySelector('[data-role="apply-id"]')?.value || `${this.calibrationId}-fit`;
        const res = await this.api?.calibration_apply?.(this._lastResult?.parameters || {}, sid, `Calibrated: ${this.calibrationId}`);
        const host = this._body().querySelector('[data-role="run-result"]');
        if (host) host.insertAdjacentHTML('beforeend', `<p class="ea-calib__muted">${res?.ok ? `Saved scenario <code>${esc(res?.scenario?.id || sid)}</code>.` : `Apply failed: ${esc(res?.error || '')}`}</p>`);
    }

    // ═══════════════════════════════════════════════════ Reference data (ETL)

    _defsBy(kind) { return Object.values(this._nodeDefs).filter((d) => d.kind === kind); }
    _def(type) { return this._nodeDefs[type] || { config: {}, ports: { inputs: 1, outputs: 1 }, kind: 'transform' }; }
    _inputCount(type) { const p = this._def(type).ports?.inputs; return p === 'variadic' ? 2 : (p ?? 1); }

    _newGraph() {
        const src = { id: nid(), type: 'worldbank', config: {}, inputs: [] };
        const sink = { id: nid(), type: 'reference', config: {}, inputs: [src.id] };
        return { id: '', name: '', nodes: [src, sink] };
    }

    async _renderReference() {
        await this._refreshRefSeries();
        const pipes = await this.api?.etl_pipelines_list?.();
        const pipelines = pipes?.pipelines || [];
        if (!this._graph) this._graph = this._newGraph();
        this._body().innerHTML = `
            <div class="ea-calib__split">
                <aside class="ea-calib__side">
                    <div class="ea-calib__side-head"><span>Pipelines</span><span><button class="ea-btn ea-btn--small" data-action="preset">Preset</button> <button class="ea-btn ea-btn--small" data-action="new-pipe">New</button></span></div>
                    <ul class="ea-calib__list" data-role="pipe-list">${pipelines.length ? pipelines.map((p) => `<li class="ea-calib__item" data-pid="${esc(p.id)}"><span class="ea-calib__item-name">${esc(p.name || p.id)}</span><span class="ea-calib__item-meta">${p.n_steps}n</span></li>`).join('') : '<li class="ea-calib__empty">No pipelines.</li>'}</ul>
                    <div class="ea-calib__side-head"><span>Reference series</span></div>
                    <ul class="ea-calib__list" data-role="ref-list">${this._refSeries.length ? this._refSeries.map((s) => `<li class="ea-calib__item" data-id="${esc(s.series_id)}"><span class="ea-calib__item-name">${esc(s.label || s.series_id)}</span><span class="ea-calib__item-meta">${s.n}pts</span><button class="ea-btn ea-btn--icon" data-action="rm-ref" data-id="${esc(s.series_id)}"><span class="material-symbols-outlined">delete</span></button></li>`).join('') : '<li class="ea-calib__empty">None yet.</li>'}</ul>
                    <div class="ea-calib__chart" data-role="ref-preview"></div>
                </aside>
                <section class="ea-calib__main" data-role="pipeline"></section>
            </div>`;
        this._body().querySelector('[data-action="new-pipe"]').addEventListener('click', () => { this._graph = this._newGraph(); this._sel = null; this._nodePreview = {}; this._renderGraphEditor(); });
        this._body().querySelector('[data-action="preset"]').addEventListener('click', () => this._openPreset());
        this._body().querySelectorAll('[data-pid]').forEach((li) => li.addEventListener('click', () => this._loadPipeline(li.dataset.pid)));
        this._body().querySelectorAll('.ea-calib__item[data-id]').forEach((li) => li.addEventListener('click', (e) => { if (!e.target.closest('[data-action="rm-ref"]')) this._previewRef(li.dataset.id); }));
        this._body().querySelectorAll('[data-action="rm-ref"]').forEach((b) => b.addEventListener('click', async () => { await this.api?.etl_reference_delete?.(b.dataset.id); this._renderReference(); }));
        this._renderGraphEditor();
        if (this._pendingPipelineId) { const pid = this._pendingPipelineId; this._pendingPipelineId = null; this._loadPipeline(pid); }
    }

    async _previewRef(id) {
        const host = this._body().querySelector('[data-role="ref-preview"]');
        const res = await this.api?.etl_reference_preview?.(id);
        const pts = (res?.points || []).filter((p) => p[0] != null && p[1] != null);
        if (host) renderLineChart(host, { height: 110, title: id, series: [{ points: pts, color: 'var(--accent-bright)' }] });
    }

    _renderGraphEditor() {
        const host = this._body().querySelector('[data-role="pipeline"]');
        const g = this._graph;
        const palette = (kind, label) => `<div class="etl-pal__grp"><span class="etl-pal__lbl">${label}</span>${this._defsBy(kind).map((d) => `<button class="etl-pal__node" data-add="${esc(d.type)}" title="${esc(d.type)}"><span class="material-symbols-outlined">${esc(d.icon || 'tune')}</span>${esc(d.label || d.type)}</button>`).join('')}</div>`;
        host.innerHTML = `
            <div class="ea-calib__ed-head">
                <input class="ea-calib__title-input" data-pl="name" value="${esc(g.name || '')}" placeholder="Pipeline name">
                <span class="ea-detail-header__spacer"></span>
                <button class="ea-btn ea-btn--small" data-action="save-pipe">Save</button>
                <button class="ea-btn ea-btn--small" data-action="preview-pipe">Preview</button>
                <button class="ea-btn ea-btn--small ea-btn--primary" data-action="run-pipe">Run → store</button></div>
            <div class="etl-editor">
                <div class="etl-pal">${palette('source', 'Sources')}${palette('transform', 'Transforms')}${palette('sink', 'Sink')}</div>
                <div class="etl-nodes" data-role="nodes"></div>
            </div>
            <section class="ea-card etl-dock" data-role="dock" hidden><h3 class="ea-card__title">Node</h3>
                <div class="ea-form-grid" data-role="node-config"></div>
                <div data-role="node-result"></div>
                <div class="ea-calib__chart" data-role="node-chart"></div>
                <div class="ea-calib__table-wrap" data-role="node-table"></div></section>`;
        host.querySelector('[data-pl="name"]').addEventListener('input', (e) => { g.name = e.target.value; });
        host.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => this._addNode(b.dataset.add)));
        host.querySelector('[data-action="save-pipe"]').addEventListener('click', () => this._savePipe());
        host.querySelector('[data-action="preview-pipe"]').addEventListener('click', () => this._runGraph(true));
        host.querySelector('[data-action="run-pipe"]').addEventListener('click', () => this._runGraph(false));
        this._renderNodes();
        if (this._sel) this._selectNode(this._sel);
    }

    _addNode(type) {
        const g = this._graph;
        const inputs = [];
        const n = this._inputCount(type);
        if (n > 0) { const prev = g.nodes[g.nodes.length - 1]; for (let i = 0; i < n; i++) inputs.push(i === 0 && prev ? prev.id : null); }
        const node = { id: nid(), type, config: {}, inputs };
        // insert before the sink if one exists (keep sink last)
        const sinkIdx = g.nodes.findIndex((x) => this._def(x.type).kind === 'sink');
        if (sinkIdx >= 0 && this._def(type).kind !== 'sink') g.nodes.splice(sinkIdx, 0, node); else g.nodes.push(node);
        this._sel = node.id; this._renderNodes(); this._selectNode(node.id);
    }

    _renderNodes() {
        const host = this._body().querySelector('[data-role="nodes"]'); const g = this._graph;
        host.innerHTML = g.nodes.map((n) => {
            const d = this._def(n.type);
            const inputs = (this._inputCount(n.type) ? n.inputs : []).map((inId, slot) => `
                <select class="etl-node__in" data-in-node="${n.id}" data-slot="${slot}"><option value="">input ${this._inputCount(n.type) > 1 ? slot + 1 : ''}…</option>${g.nodes.filter((m) => m.id !== n.id).map((m) => `<option value="${m.id}"${m.id === inId ? ' selected' : ''}>${esc(this._def(m.type).label || m.type)}</option>`).join('')}</select>`).join('');
            return `<div class="etl-node etl-node--${esc(d.category || '')}${n.id === this._sel ? ' is-sel' : ''}" data-node="${n.id}">
                <div class="etl-node__hd"><span class="material-symbols-outlined">${esc(d.icon || 'tune')}</span><span class="etl-node__ty">${esc(d.label || n.type)}</span>
                    <span class="ea-detail-header__spacer"></span><button class="ea-btn ea-btn--icon" data-rm-node="${n.id}"><span class="material-symbols-outlined">close</span></button></div>
                ${inputs ? `<div class="etl-node__ins">${inputs}</div>` : ''}
                <div class="etl-node__sum">${esc(this._summary(n))}</div></div>`;
        }).join('') || '<p class="ea-calib__muted">Add a source from the palette.</p>';
        host.querySelectorAll('.etl-node').forEach((el) => el.addEventListener('click', (e) => { if (e.target.closest('[data-rm-node]') || e.target.closest('.etl-node__in')) return; this._selectNode(el.dataset.node); }));
        host.querySelectorAll('[data-rm-node]').forEach((b) => b.addEventListener('click', () => this._removeNode(b.dataset.rmNode)));
        host.querySelectorAll('.etl-node__in').forEach((sel) => sel.addEventListener('change', (e) => {
            const node = g.nodes.find((x) => x.id === e.target.dataset.inNode);
            node.inputs[Number(e.target.dataset.slot)] = e.target.value || null;
        }));
    }

    _summary(n) {
        const c = n.config || {};
        const bits = Object.entries(c).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length)).slice(0, 3)
            .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : (typeof v === 'object' ? '…' : v)}`);
        return bits.join('  ') || 'unconfigured';
    }

    _removeNode(id) {
        const g = this._graph;
        g.nodes = g.nodes.filter((n) => n.id !== id);
        g.nodes.forEach((n) => { n.inputs = (n.inputs || []).map((x) => x === id ? null : x); });
        if (this._sel === id) this._sel = null;
        this._renderNodes();
        const dock = this._body().querySelector('[data-role="dock"]'); if (dock) dock.hidden = true;
    }

    _upstreamColumns(node) {
        const up = (node.inputs || [])[0];
        return up && this._nodePreview[up] ? (this._nodePreview[up].columns || []) : [];
    }

    _selectNode(id) {
        this._sel = id; this._renderNodes();
        const node = this._graph.nodes.find((n) => n.id === id); if (!node) return;
        const dock = this._body().querySelector('[data-role="dock"]'); dock.hidden = false;
        dock.querySelector('.ea-card__title').textContent = this._def(node.type).label || node.type;
        renderNodeConfigForm(this._body().querySelector('[data-role="node-config"]'), {
            descriptor: this._def(node.type), value: node.config, upstreamColumns: this._upstreamColumns(node),
            onChange: () => { this._renderNodeSummary(id); },
        });
        this._renderNodePreview(node);
    }
    _renderNodeSummary(id) {
        const el = this._body().querySelector(`.etl-node[data-node="${id}"] .etl-node__sum`);
        const n = this._graph.nodes.find((x) => x.id === id);
        if (el && n) el.textContent = this._summary(n);
    }

    _renderNodePreview(node) {
        const prev = this._nodePreview[node.id];
        const chart = this._body().querySelector('[data-role="node-chart"]');
        const table = this._body().querySelector('[data-role="node-table"]');
        const result = this._body().querySelector('[data-role="node-result"]');
        if (!prev) { if (result) result.innerHTML = '<p class="ea-calib__muted">Preview the pipeline to see this node\'s output.</p>'; if (chart) chart.innerHTML = ''; if (table) table.innerHTML = ''; return; }
        if (result) result.innerHTML = `<p class="ea-calib__muted">${prev.n} rows · ${prev.columns.length} cols</p>`;
        if (table) table.innerHTML = `<table class="ea-table"><thead><tr>${prev.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${(prev.rows || []).slice(0, 8).map((row) => `<tr>${row.map((v) => `<td>${v == null ? '' : esc(String(v))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        const ti = prev.columns.indexOf('t'), vi = prev.columns.indexOf('value');
        if (chart && ti >= 0 && vi >= 0) { const pts = (prev.rows || []).map((r) => [r[ti], r[vi]]).filter((p) => p[0] != null && p[1] != null); if (pts.length) renderLineChart(chart, { height: 110, title: 'series', series: [{ points: pts, color: 'var(--color-success)' }] }); else chart.innerHTML = ''; }
        else if (chart) chart.innerHTML = '';
    }

    _buildGraphSpec() {
        const g = this._graph;
        const connections = [];
        g.nodes.forEach((n) => (n.inputs || []).forEach((src) => { if (src) connections.push({ source: src, target: n.id }); }));
        const nodes = g.nodes.map((n) => {
            const cfg = { ...n.config };
            if (n.type === 'inline' && typeof cfg.data === 'string') cfg.data = cfg.data.trim().split('\n').map((l) => l.split(',').map((x) => Number(x.trim()))).filter((r) => r.length >= 2 && r.every((x) => isFinite(x)));
            return { id: n.id, type: n.type, config: cfg };
        });
        return { id: g.id, name: g.name, nodes, connections };
    }

    async _runGraph(preview) {
        const dock = this._body().querySelector('[data-role="dock"]'); dock.hidden = false;
        const result = this._body().querySelector('[data-role="node-result"]');
        const sink = this._graph.nodes.find((n) => this._def(n.type).kind === 'sink');
        if (!preview && !(sink && sink.config.series_id)) { if (result) result.innerHTML = '<p class="ea-calib__err">The sink needs a series id.</p>'; return; }
        if (result) result.innerHTML = '<p class="ea-calib__muted">Running…</p>';
        const res = await this.api?.etl_pipeline_run?.(this._buildGraphSpec(), preview);
        if (!res?.ok) { if (result) result.innerHTML = `<p class="ea-calib__err">${esc(res?.error || 'pipeline failed')}</p>`; return; }
        this._nodePreview = res.node_preview || {};
        if (this._sel) this._selectNode(this._sel); else { const s = sink || this._graph.nodes[this._graph.nodes.length - 1]; if (s) this._selectNode(s.id); }
        if (!preview) {
            const stored = res.sinks?.[0];
            await this._refreshRefSeries();
            // ETL→calibration link: if we came here to build a target, bind it
            if (this._pendingRefTarget && stored?.series_id && this._spec) {
                const t = this._spec.targets[this._pendingRefTarget.targetIndex];
                if (t) { t.reference = stored.series_id; this._dirty = true; }
                this._pendingRefTarget = null;
                this._setHeaderHint(`Stored ${stored.series_id} — bound to your calibration target.`);
            }
            this._renderReference();
        }
    }
    _setHeaderHint(h) { const e = this._root.querySelector('[data-role="header-hint"]'); if (e) e.textContent = h || ''; }

    async _savePipe() {
        const g = this._graph;
        if (!g.id) g.id = (g.name || 'pipeline').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pipeline';
        const res = await this.api?.etl_pipeline_save?.(g.id, this._buildGraphSpec());
        if (!res?.ok) { toastError(`Save failed: ${res?.error || ''}`); return; }
        this._notifyProject(); this._renderReference();
    }

    async _loadPipeline(id) {
        const res = await this.api?.etl_pipeline_get?.(id);
        if (!res?.ok || !res.pipeline) return;
        this._graph = this._fromSpec(res.pipeline); this._sel = null; this._nodePreview = {}; this._renderGraphEditor();
    }

    _fromSpec(p) {
        // Accept both {nodes,connections} and legacy linear {steps}.
        if (p.nodes) {
            const inbound = {}; (p.connections || []).forEach((c) => { (inbound[c.target] = inbound[c.target] || []).push(c.source); });
            return { id: p.id || '', name: p.name || '', nodes: p.nodes.map((n) => ({ id: n.id, type: n.type, config: { ...n.config }, inputs: inbound[n.id] || [] })) };
        }
        const steps = p.steps || []; let prev = null; const nodes = [];
        steps.forEach((s) => { const id = nid(); nodes.push({ id, type: s.type, config: { ...s.config }, inputs: prev ? [prev] : [] }); prev = id; });
        return { id: p.id || '', name: p.name || '', nodes };
    }

    async _openPreset() {
        const res = await this.api?.etl_preset_list?.();
        const presets = res?.presets || [];
        if (!presets.length) { toastError('No presets available'); return; }
        const host = this._body().querySelector('[data-role="pipeline"]');
        host.innerHTML = `
            <div class="ea-calib__ed-head"><h3 class="ea-card__title">Choose a preset</h3>
                <span class="ea-detail-header__spacer"></span>
                <button class="ea-btn ea-btn--small" data-action="cancel-preset">Cancel</button></div>
            <ul class="ea-calib__list">${presets.map((p) => `
                <li class="ea-calib__preset" data-id="${esc(p.id)}">
                    <div class="ea-calib__item"><span class="ea-calib__item-name">${esc(p.name || p.id)}</span><span class="ea-calib__item-meta">${p.n_nodes} nodes</span></div>
                    <div class="ea-calib__muted ea-calib__preset-desc">${esc(p.description || '')}</div></li>`).join('')}</ul>`;
        host.querySelector('[data-action="cancel-preset"]').addEventListener('click', () => this._renderGraphEditor());
        host.querySelectorAll('[data-id]').forEach((li) => li.addEventListener('click', async () => {
            const got = await this.api?.etl_preset_get?.(li.dataset.id);
            if (got?.ok) { this._graph = this._fromSpec(got.pipeline); this._sel = null; this._nodePreview = {}; this._renderGraphEditor(); }
        }));
    }
}
