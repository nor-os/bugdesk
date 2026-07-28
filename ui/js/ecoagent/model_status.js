/**
 * model_status.js — drives the two indicators in the global bottom bar.
 *
 * `#status-indicator` (bar-left, OK / Invalid badge):
 *   Replaces Ecosim's `ValidationStatus`, which keys on `dsl:generated`
 *   events the EcoAgent project never emits. We check:
 *     · SFC consistency  (Σ Assets = Σ Liabilities + Σ Equity per asset
 *                         kind across all sectors, via the live ledger
 *                         when a world is running, the initial-value
 *                         seed otherwise)
 *     · Code errors      (`world_run_log()` entries with level=error —
 *                         exceptions caught in agents' loop bodies)
 *     · Contract checks  (`build_status()` violations — schema validation,
 *                         base-class inheritance, reference integrity,
 *                         variation overrides, dependency edges, …)
 *   Triggers: every run completion, project change, and explicit click.
 *
 * `#sim-status` (text, "Simulation idle." default):
 *   Driven by the `ecoagent:run:*` events emitted by runtime_controls.
 *   Reflects: Ready · Starting · Running t T/N · Complete · Error.
 */

import { getSetting } from '../core/settings.js';

export function installModelStatus({ eventBus, logger } = {}) {
    const log = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
    const m = new ModelStatus(eventBus, log);
    m.install();
    return m;
}


class ModelStatus {
    constructor(eventBus, log) {
        this.eventBus = eventBus;
        this.log = log;
        this._indicator = null;
        this._simStatus = null;
        this._validationTimer = null;
        this._runActive = false;
    }

    install() {
        const indicator = document.getElementById('status-indicator');
        const simStatus = document.getElementById('sim-status');
        if (!indicator || !simStatus) {
            // The shell mounts these at boot; retry next frame.
            requestAnimationFrame(() => this.install());
            return;
        }
        // Take over the existing `#status-indicator` from Ecosim's
        // ValidationStatus by cloning — drops any prior listeners.
        const fresh = indicator.cloneNode(true);
        indicator.replaceWith(fresh);
        this._indicator = fresh;
        fresh.style.cursor = 'pointer';
        // Click opens the issue popover; the popover has its own
        // refresh button. Right-click forces a refresh without
        // opening the popover (cheaper).
        fresh.addEventListener('click', (e) => {
            e.preventDefault();
            this._togglePopover();
        });
        fresh.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.refresh();
        });

        this._simStatus = simStatus;

        this._wireEvents();
        this._initialSimStatus();
        this.refresh();
    }

    // ------------------------------------------------------------- wiring

    _wireEvents() {
        const bus = this.eventBus;
        if (!bus?.on) return;
        bus.on('ecoagent:run:started',     (p) => this._onRunStarted(p));
        bus.on('ecoagent:run:tick',        (p) => this._onRunTick(p));
        bus.on('ecoagent:run:completed',   (p) => this._onRunCompleted(p));
        bus.on('ecoagent:run:error',       (p) => this._onRunError(p));
        bus.on('ecoagent:project:changed', () => {
            this._setSimStatus('Ready.', 'info');
            this._scheduleValidation();
            this._refreshScenarioStatus();
        });
        // Scenario lifecycle — show last-run info for the newly active one.
        bus.on('ecoagent:scenarios:changed', () => this._refreshScenarioStatus());
        bus.on('ecoagent:batch:completed',   () => this._refreshScenarioStatus());
    }

    // -------------------------------------------------------- sim-status

    _onRunStarted({ ticks, batch } = {}) {
        this._runActive = true;
        // A batch run has no single tick counter — drive a progress bar in the
        // bottom bar from a poll of scenarios_results_summary.
        if (batch) this._startBatchPoll();
        // A fresh run hasn't pushed its health slice yet. Tracks whether
        // the authoritative `run:completed` push (with `sfc`/`code`) has
        // arrived, so the trailing `{ticks}`-only echo from runtime_controls
        // doesn't clobber it and the WS-down fallback poll fires at most once.
        this._sfcFromPush = false;
        // sim-status describes the *state* only; the precise tick
        // counter lives in #sim-tick (bar-right, driven by
        // runtime_controls._renderTick on every push). The two
        // updaters fire at different cadences — keeping the tick
        // number out of sim-status is what stops them from disagreeing
        // by up to `ecoagent.run.coarseRefreshTicks` ticks.
        const target = (ticks != null) ? ` (${ticks} ticks)` : '';
        this._setSimStatus(`Starting run${target}…`, 'progress');
    }

    _onRunTick(_payload) {
        if (!this._runActive) this._runActive = true;
        // Intentionally no tick number — #sim-tick owns the clock.
        this._setSimStatus('Running…', 'progress');
    }

    _onRunCompleted(payload) {
        this._runActive = false;
        this._stopBatchPoll();
        this._renderBatchBar(null);   // hide the batch bar
        if (payload?.kind === 'reset') {
            this._setSimStatus('Reset.', 'info');
        } else if (payload?.error) {
            this._setSimStatus(`Run halted: ${payload.error}`, 'error');
        } else {
            this._setSimStatus('Complete.', 'success');
            // Optional success toast — opt-in via settings since most
            // users don't want a popup on every run.
            if (getSetting('ecoagent.run.showCompletionToast')) {
                const tick = payload?.current ?? payload?.tick;
                this.eventBus?.emit?.('notification:show', {
                    title: 'Run complete',
                    message: (tick != null) ? `World ran to tick ${tick}.` : 'World run finished.',
                    severity: 'success',
                });
            }
        }
        // The health slice (SFC identity + run/agent errors) rides this
        // push — see Bridge._sfc_status_payload. Consume it directly
        // instead of firing the old 6-call `_validate()` poll storm (which
        // also needlessly re-ran the build-time contract check post-run).
        this._applyRunResultFromPayload(payload);
    }

    _onRunError(payload) {
        this._runActive = false;
        this._setSimStatus(`Error: ${payload?.error || 'simulation error'}`, 'error');
        // No validation here: the run thread's `finally` always emits a
        // `run:completed` (carrying the world error in its `code` slice)
        // right after this, so `_onRunCompleted` refreshes the indicator.
    }

    /** Update the indicator from a `run:completed` payload. The authoritative
     *  push carries `sfc`/`code` arrays (computed server-side); the trailing
     *  `{ticks}` echo and the WS-down path don't, so fall back to a single
     *  `sfc_status()` call — never the full `_validate()` (no post-run
     *  build-status). */
    _applyRunResultFromPayload(payload) {
        if (payload && Array.isArray(payload.sfc)) {
            this._sfcFromPush = true;
            this._applyRunResult(payload.sfc, payload.code);
            return;
        }
        if (this._sfcFromPush) return;   // already rendered from the push
        this._scheduleSfcStatus();
    }

    /** Merge a fresh SFC/code result into the cached issues and repaint,
     *  preserving the last-known contract slice (unchanged by a run). */
    _applyRunResult(sfc, code) {
        const issues = this._lastIssues || this._emptyIssues();
        issues.sfc = Array.isArray(sfc) ? sfc : [];
        if (Array.isArray(code)) issues.code = code;
        issues.worldActive = true;
        issues.preRun = false;
        this._lastIssues = issues;
        this._renderIndicator(issues);
        if (this._popoverEl?.isConnected) this._renderPopoverContent();
    }

    _emptyIssues() {
        return {
            sfc: [], code: [], contract: [],
            worldActive: false, contractChecked: false, contractError: null,
        };
    }

    /** Debounced single-call fallback used only when the run:completed push
     *  didn't carry the health slice (e.g. streaming socket down). */
    _scheduleSfcStatus() {
        if (this._sfcStatusTimer) clearTimeout(this._sfcStatusTimer);
        this._sfcStatusTimer = setTimeout(async () => {
            try {
                const s = await window.pywebview?.api?.sfc_status?.();
                if (s) this._applyRunResult(s.sfc, s.code);
            } catch (err) {
                this.log.warn?.('sfc_status fallback failed', { err });
            }
        }, 200);
    }

    async _initialSimStatus() {
        try {
            const s = await window.pywebview?.api?.world_run_status?.();
            if (s?.running) {
                this._runActive = true;
                this._setSimStatus('Running…', 'progress');
            } else if (s?.active) {
                this._setSimStatus('Idle.', 'info');
            } else {
                this._setSimStatus('BugDesk ready.', 'info');
            }
        } catch {
            this._setSimStatus('Ready.', 'info');
        }
        this._refreshScenarioStatus();
    }

    /** Pull the per-scenario last-run cache and update the
     *  `#sim-status` line + a sibling "last run" element so the user can
     *  see, at a glance, whether the currently-loaded scenario already
     *  has a stored batch result. */
    async _refreshScenarioStatus() {
        let summary;
        try {
            summary = await window.pywebview?.api?.scenarios_results_summary?.();
        } catch { return; }
        if (!summary) return;
        const key = summary.active ? String(summary.active) : '';
        const info = summary.results?.[key];
        const el = this._ensureScenarioStatusEl();
        if (!el) return;
        if (summary.batch?.running) {
            const done = summary.batch.completed || 0;
            const total = summary.batch.total || 0;
            el.textContent = `Batch running · ${done}/${total} scenarios`;
            el.title = 'A parallel scenario batch is in progress';
            el.classList.add('is-progress');
            el.classList.remove('is-error', 'is-info');
            return;
        }
        if (!info || !info.ran_at) {
            el.textContent = '';
            el.title = '';
            el.classList.remove('is-progress', 'is-error', 'is-info');
            return;
        }
        const when = _formatRelativeTime(info.ran_at);
        const label = summary.active ? key : 'Baseline';
        if (info.error) {
            el.textContent = `${label} failed at t${info.tick} · ${when}`;
            el.title = info.error;
            el.classList.remove('is-progress', 'is-info');
            el.classList.add('is-error');
        } else {
            el.textContent = `${label} · last run t${info.tick}/${info.target} · ${when}`;
            el.title = `Cached batch result for "${label}" — ran to tick ${info.tick} of ${info.target} at ${new Date(info.ran_at * 1000).toLocaleString()}`;
            el.classList.remove('is-progress', 'is-error');
            el.classList.add('is-info');
        }
    }

    _ensureScenarioStatusEl() {
        if (this._scenarioStatusEl?.isConnected) return this._scenarioStatusEl;
        const sim = this._simStatus;
        if (!sim) return null;
        const el = document.createElement('span');
        el.id = 'ea-scenario-status';
        el.className = 'ea-scenario-status';
        sim.parentNode?.insertBefore(el, sim.nextSibling);
        this._scenarioStatusEl = el;
        return el;
    }

    // ---------------------------------------------------- batch progress bar

    /** Poll the batch summary while a parallel batch is running and drive the
     *  bottom-bar progress bar. Self-terminates when the batch finishes. */
    _startBatchPoll() {
        this._stopBatchPoll();
        const tick = async () => {
            let summary;
            try { summary = await window.pywebview?.api?.scenarios_results_summary?.(); }
            catch { this._batchPollTimer = setTimeout(tick, 600); return; }
            this._renderBatchBar(summary);
            if (summary?.batch?.running) {
                this._batchPollTimer = setTimeout(tick, 400);
            } else {
                this._stopBatchPoll();
                this._renderBatchBar(null);
                this._refreshScenarioStatus();
            }
        };
        tick();
    }

    _stopBatchPoll() {
        if (this._batchPollTimer) { clearTimeout(this._batchPollTimer); this._batchPollTimer = null; }
    }

    _ensureBatchBarEl() {
        if (this._batchBarEl?.isConnected) return this._batchBarEl;
        const sim = this._simStatus;
        if (!sim) return null;
        const el = document.createElement('span');
        el.id = 'ea-batch-bar';
        el.className = 'ea-batch-bar';
        el.style.display = 'none';
        el.style.cursor = 'pointer';
        el.title = 'Open the batch window';
        el.innerHTML =
            '<span class="ea-batch-bar__label"></span>'
            + '<span class="ea-batch-bar__track"><span class="ea-batch-bar__fill"></span></span>';
        // Clicking the bottom-bar batch indicator re-opens / restores the batch
        // window (it minimizes rather than closes during a run).
        el.addEventListener('click', () => this.eventBus?.emit?.('ecoagent:batch:reopen'));
        sim.parentNode?.insertBefore(el, sim.nextSibling);
        this._batchBarEl = el;
        return el;
    }

    _renderBatchBar(summary) {
        const el = this._ensureBatchBarEl();
        if (!el) return;
        if (!summary || !summary.batch?.running) { el.style.display = 'none'; return; }
        const results = Object.values(summary.results || {});
        const done    = results.reduce((a, r) => a + (Number(r.tick) || 0), 0);
        const planned = results.reduce((a, r) => a + (Number(r.target) || 0), 0);
        const pct = planned ? Math.round((done / planned) * 100) : 0;
        const sc = summary.batch.completed || 0;
        const st = summary.batch.total || 0;
        const paused = summary.batch.paused ? ' · paused' : '';
        el.style.display = '';
        el.querySelector('.ea-batch-bar__label').textContent =
            `Batch ${sc}/${st}${paused} · ${pct}%`;
        el.querySelector('.ea-batch-bar__fill').style.width = `${pct}%`;
        el.classList.toggle('is-paused', !!summary.batch.paused);
    }

    _setSimStatus(text, tone = 'info') {
        if (!this._simStatus) return;
        this._simStatus.textContent = text;
        const tones = ['info', 'success', 'warn', 'error', 'progress'];
        for (const t of tones) {
            this._simStatus.classList.toggle(`is-${t}`, t === tone);
        }
    }

    // ----------------------------------------------------- validation flow

    _scheduleValidation() {
        if (this._validationTimer) clearTimeout(this._validationTimer);
        this._validationTimer = setTimeout(() => this.refresh(), 200);
    }

    async refresh() {
        if (!this._indicator) return;
        this._setIndicator('hourglass_top', 'Checking…', 'progress',
            'Checking SFC consistency and agent error log…');
        let issues;
        try { issues = await this._validate(); }
        catch (err) {
            this.log.warn?.('model_status validate failed', { err });
            this._setIndicator('help', '?', 'invalid',
                'Validation failed — check the console for details.');
            return;
        }
        this._lastIssues = issues;
        this._renderIndicator(issues);
        // If the popover is open, repaint its content too.
        if (this._popoverEl?.isConnected) this._renderPopoverContent();
    }

    async _validate() {
        const issues = {
            sfc: [], code: [], contract: [],
            worldActive: false,
            contractChecked: false,    // did build_status return cleanly?
            contractError:  null,      // bridge-side error, if any
        };

        // World status — feeds the "no world yet" tooltip and surfaces
        // any backend run error directly.
        try {
            const status = await window.pywebview?.api?.world_run_status?.();
            issues.worldActive = !!status?.active;
            if (status?.error) {
                issues.code.push({ scope: 'world', message: String(status.error) });
            }
        } catch { /* no world yet */ }

        // #128 — contract / schema-validation violations from the
        // project-wide validator. Each entry already carries severity
        // + entity refs; the popover renders them as a click-through
        // list. Errors here block world-build (`ok=false`).
        try {
            const bs = await window.pywebview?.api?.build_status?.();
            // Bridge unreachable / endpoint absent → leave contractChecked
            // false so the indicator falls back to its loading message.
            if (bs && typeof bs === 'object') {
                issues.contractChecked = true;
                const list = Array.isArray(bs.violations) ? bs.violations : [];
                for (const v of list) {
                    issues.contract.push({
                        severity:    String(v?.severity || 'error'),
                        entity_kind: String(v?.entity_kind || ''),
                        entity_id:   String(v?.entity_id   || ''),
                        target_kind: String(v?.target_kind || ''),
                        target_id:   String(v?.target_id   || ''),
                        attribute:   v?.attribute ?? null,
                        message:     String(v?.message || ''),
                    });
                }
            }
        } catch (err) {
            // Surface the bridge error instead of swallowing it. Without
            // this the indicator sits on "OK / no world loaded" while the
            // contract validator is actually broken.
            issues.contractError = String(err?.message || err);
            this.log.warn?.('build_status failed', { err });
        }

        // Agent code errors: read the run log from cursor 0 to get every
        // exception caught so far, filtered to level=error.
        try {
            const res = await window.pywebview?.api?.world_run_log?.(0);
            const entries = Array.isArray(res?.entries) ? res.entries : [];
            for (const e of entries) {
                if (String(e.level || 'info') !== 'error') continue;
                issues.code.push({
                    scope: 'agent',
                    source: e.source,
                    tick: e.tick,
                    message: e.message,
                });
            }
        } catch { /* run log unavailable */ }

        // SFC consistency: check the accounting identity A − L − E = 0
        // at two aggregation levels — both must hold:
        //
        //   1. PER-SECTOR (across all kinds combined). Mirrors the
        //      "A − L − E = …" footer the sector tab shows under each
        //      sector's balance sheet. Per sector, books *have to*
        //      balance: equity is the residual. A nonzero remainder
        //      means the equity entry for that sector is out of date.
        //      This is the level the user typically notices — multiple
        //      sectors can be off at once while still summing to zero
        //      across the cross-sector aggregate, so the per-kind
        //      check alone misses them.
        //
        //   2. PER-KIND (across all sectors). Mirrors the SFC overview
        //      tab's cross-sector card. Cross-sector totals per kind
        //      should net to zero; nonzero means a claim was created
        //      or destroyed (a true leak in the pair-claim sense).
        //
        // Both views read the same `sfc_balance_sheet` snapshot we
        // pull here, so the status bar and the SFC pages can no
        // longer disagree.
        //
        // The pre-run flag tells the popover to label results as a
        // template-aggregation estimate: `_balance_initial_books` only
        // runs at world build time, so customer deposits and bank
        // reserves look unpaired until Run is clicked.
        try {
            const [bs, sectors, kinds] = await Promise.all([
                window.pywebview?.api?.sfc_balance_sheet?.()  ?? {},
                window.pywebview?.api?.sectors_list?.()       ?? [],
                window.pywebview?.api?.assets_list?.()   ?? [],
            ]);
            issues.preRun = !issues.worldActive;
            // Only iterate user-declared sectors — `bs` may include
            // synthetic plumbing sectors (e.g. 'reservoirs' for the
            // counterparties of unconserved real-asset kinds) that
            // the user never modelled and that don't have a per-sector
            // identity to satisfy.
            const sectorLabel = new Map(
                (Array.isArray(sectors) ? sectors : [])
                    .map((s) => [s.id, s.label || s.id]),
            );
            const sectorIds = Array.from(sectorLabel.keys())
                .filter((sid) => Object.prototype.hasOwnProperty.call(bs || {}, sid));

            // Per-sector totals (all kinds combined). Threshold 1e-2:
            // PaymentEngine settlement and percentage-based flows drift
            // by sub-cent amounts over many ticks; that's numerical
            // noise, not a flow leak. Real missing equity legs land in
            // the cents-and-up range and still flag.
            for (const sid of sectorIds) {
                let A = 0, L = 0, E = 0;
                const perKind = bs[sid] || {};
                for (const kindId of Object.keys(perKind)) {
                    const r = perKind[kindId] || {};
                    if (Number.isFinite(r.Assets))      A += r.Assets;
                    if (Number.isFinite(r.Liabilities)) L += r.Liabilities;
                    if (Number.isFinite(r.Equity))      E += r.Equity;
                }
                const net = A - L - E;
                if (Math.abs(net) > 1e-2) {
                    issues.sfc.push({
                        scope:   'sector',
                        sectorId: sid,
                        label:    sectorLabel.get(sid) || sid,
                        net,
                    });
                }
            }

            // Per-kind totals (all sectors combined). Only financial
            // kinds (deposits, loans, bonds, reserves, …) need to net
            // to zero across sectors — every claim of those kinds is
            // someone else's matched liability. Real-asset kinds
            // (goods, capital, land, energy, fx) and the equity
            // residual have no per-kind counterparty by design; their
            // sector-level balance is captured by the per-sector check
            // above. Skipping them here matches what the Ledger
            // actually enforces (`is_financial=False` kinds bypass the
            // per-kind conservation check).
            for (const k of (Array.isArray(kinds) ? kinds : [])) {
                if (k.is_financial === false) continue;
                let A = 0, L = 0, E = 0;
                for (const sid of sectorIds) {
                    const r = bs?.[sid]?.[k.id] || {};
                    if (Number.isFinite(r.Assets))      A += r.Assets;
                    if (Number.isFinite(r.Liabilities)) L += r.Liabilities;
                    if (Number.isFinite(r.Equity))      E += r.Equity;
                }
                const net = A - L - E;
                if (Math.abs(net) > 1e-2) {
                    issues.sfc.push({
                        scope:  'kind',
                        kindId: k.id,
                        label:  k.label || k.id,
                        net,
                    });
                }
            }
        } catch { /* no kinds / no sectors yet */ }

        return issues;
    }

    _renderIndicator(issues) {
        const sfcCount      = issues.sfc.length;
        const codeCount     = issues.code.length;
        const contractList  = issues.contract || [];
        const contractErrs  = contractList.filter((v) => v.severity === 'error').length;
        const contractWarns = contractList.filter((v) => v.severity !== 'error').length;
        const total = sfcCount + codeCount + contractList.length;

        // Bridge call itself failed — surface the breakage instead of
        // pretending validation is clean.
        if (issues.contractError) {
            this._setIndicator(
                'sync_problem',
                'Check failed',
                'invalid',
                `Contract validator threw: ${issues.contractError}`,
            );
            return;
        }

        if (total === 0) {
            // Build the OK tooltip out of what was actually checked, so
            // "nothing to check" only shows when literally no check ran.
            const checked = [];
            if (issues.contractChecked) checked.push('contract');
            if (issues.worldActive)     checked.push('SFC balance');
            checked.push('agent code');
            const tip = checked.length === 0
                ? 'No checks have run yet'
                : `OK — ${checked.join(', ')} clean`
                  + (issues.worldActive ? '' : ' (no live world)');
            this._setIndicator('check_circle', 'OK', 'ok', tip);
            return;
        }

        const labels = [];
        if (sfcCount)      labels.push(`SFC ×${sfcCount}`);
        if (codeCount)     labels.push(`Errors ×${codeCount}`);
        if (contractErrs)  labels.push(`Contract ×${contractErrs}`);
        if (contractWarns) labels.push(`Warn ×${contractWarns}`);

        const tipLines = [];
        if (sfcCount) {
            const detail = issues.sfc
                .map((s) => {
                    const scope = s.scope === 'sector' ? 'sector' : 'economy-wide';
                    const sign = s.net >= 0 ? '+' : '';
                    return `${s.label} (${scope}): off by ${sign}${s.net.toFixed(4)}`;
                })
                .join('; ');
            tipLines.push(`SFC unbalanced — ${detail}`);
        }
        if (codeCount) {
            const sample = issues.code.slice(0, 3).map((e) => {
                const where = (e.tick != null) ? `t${e.tick}` : '';
                const src = e.source ? ` ${e.source}` : '';
                return `${where}${src}: ${e.message}`;
            }).join(' | ');
            tipLines.push(
                `Agent errors — ${sample}${codeCount > 3 ? ` (+${codeCount - 3} more)` : ''}`
            );
        }
        if (contractList.length) {
            const sample = contractList.slice(0, 3).map((v) => {
                const ref = v.entity_kind && v.entity_id
                    ? `${v.entity_kind}:${v.entity_id}`
                    : (v.entity_kind || '');
                return `${ref ? ref + ' — ' : ''}${v.message}`;
            }).join(' | ');
            const extra = contractList.length > 3
                ? ` (+${contractList.length - 3} more)` : '';
            tipLines.push(`Contract — ${sample}${extra}`);
        }
        // SFC drift and agent errors are always hard errors. Contract
        // errors are too. Contract warnings are amber-only — when the
        // total breakdown contains zero "real" errors, surface as a
        // `warn` state so the indicator goes yellow/orange instead of
        // red.
        const hardErrors = sfcCount + codeCount + contractErrs;
        if (hardErrors === 0 && contractWarns > 0) {
            this._setIndicator('warning', labels.join(' · '), 'warn',
                tipLines.join('\n'));
            return;
        }
        this._setIndicator('error', labels.join(' · '), 'invalid', tipLines.join('\n'));
    }

    _setIndicator(icon, text, klass, tooltip) {
        const el = this._indicator;
        if (!el) return;
        el.classList.remove('ok', 'warn', 'loop', 'invalid', 'progress');
        el.classList.add(klass);
        el.innerHTML =
            `<span class="material-symbols-outlined">${icon}</span>`
            + `<span>${esc(text)}</span>`;
        el.title = tooltip || '';
    }

    // ----------------------------------------------------------- popover

    _togglePopover() {
        if (this._popoverEl?.isConnected) {
            this._closePopover();
            return;
        }
        this._openPopover();
    }

    _openPopover() {
        this._closePopover();
        const pop = document.createElement('div');
        pop.className = 'ea-model-issues-popover';
        document.body.appendChild(pop);
        this._popoverEl = pop;

        // Anchor above the indicator (it lives in the bottom bar) with
        // viewport clamping. Position after first paint so we know the
        // popover's real height.
        const place = () => {
            if (!pop.isConnected || !this._indicator) return;
            const a = this._indicator.getBoundingClientRect();
            const r = pop.getBoundingClientRect();
            const gap = 8;
            let top = a.top - r.height - gap;
            if (top < 8) top = a.bottom + gap;       // flip if no room above
            let left = a.left;
            const vw = window.innerWidth;
            left = Math.max(8, Math.min(left, vw - r.width - 8));
            pop.style.left = `${Math.round(left)}px`;
            pop.style.top  = `${Math.round(top)}px`;
        };

        // Render content (may set !_lastIssues briefly if no validate
        // has run yet — refresh kicks one in that case).
        this._renderPopoverContent();
        if (!this._lastIssues) this.refresh();

        // Two rAF passes: first paint to measure, second to position.
        requestAnimationFrame(() => requestAnimationFrame(place));

        const onDocDown = (e) => {
            if (!pop.contains(e.target) && !this._indicator.contains(e.target)) {
                this._closePopover();
            }
        };
        const onKey = (e) => { if (e.key === 'Escape') this._closePopover(); };
        const onResize = () => place();
        // Defer the document listener so the click that opened the
        // popover doesn't immediately close it.
        setTimeout(() => {
            document.addEventListener('mousedown', onDocDown, true);
        }, 0);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', onResize);
        this._popoverCleanup = () => {
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', onResize);
        };
    }

    _closePopover() {
        if (this._popoverCleanup) { this._popoverCleanup(); this._popoverCleanup = null; }
        this._popoverEl?.remove();
        this._popoverEl = null;
    }

    _renderPopoverContent() {
        const pop = this._popoverEl;
        if (!pop) return;
        const issues = this._lastIssues
            || { sfc: [], code: [], contract: [], worldActive: false };
        const sfcCount      = issues.sfc.length;
        const codeCount     = issues.code.length;
        const contractList  = issues.contract || [];
        const contractCount = contractList.length;
        const total         = sfcCount + codeCount + contractCount;

        const header = total === 0
            ? `<span class="material-symbols-outlined ea-mi__icon ea-mi__icon--ok">check_circle</span>
               <span class="ea-mi__title">Model OK</span>`
            : `<span class="material-symbols-outlined ea-mi__icon ea-mi__icon--err">error</span>
               <span class="ea-mi__title">${total} issue${total === 1 ? '' : 's'}</span>`;

        const body = total === 0
            ? `<p class="ea-mi__empty">${esc(issues.worldActive
                    ? 'SFC balanced, no agent errors recorded.'
                    : 'No world loaded yet — nothing to check.')}</p>`
            : `${contractCount > 0 ? this._renderContractSection(contractList) : ''}
               ${sfcCount      > 0 ? this._renderSfcSection(issues.sfc)        : ''}
               ${codeCount     > 0 ? this._renderCodeSection(issues.code)      : ''}`;

        pop.innerHTML = `
            <header class="ea-mi__head">
                ${header}
                <span class="ea-mi__spacer"></span>
                <button type="button" class="ea-btn ea-btn--small" data-action="close"
                        title="Close">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </header>
            <div class="ea-mi__body">${body}</div>
        `;

        pop.querySelector('[data-action="close"]')
            ?.addEventListener('click', () => this._closePopover());

        // Contract rows are clickable — route to the offending entity
        // through the tiling WM the rest of the shell uses
        // (`window.__twm.wm`, set in tiling/install.js). Falls back to
        // a no-op if the WM isn't mounted yet.
        for (const el of pop.querySelectorAll('[data-nav-kind]')) {
            el.addEventListener('click', () => {
                const kind = el.getAttribute('data-nav-kind') || '';
                const id   = el.getAttribute('data-nav-id')   || '';
                if (!kind || !id) return;
                const wm = window.__twm?.wm;
                if (kind === 'archetype_viewer') {
                    wm?.navigate?.('archetype_viewer', { entityId: id });
                } else {
                    wm?.navigate?.(kind, { entityId: id, label: id });
                }
                this._closePopover();
            });
        }
    }

    _renderContractSection(items) {
        const errs  = items.filter((v) => v.severity === 'error').length;
        const warns = items.length - errs;
        // The bridge's `entity_kind` speaks the user's vocabulary
        // directly — `agent_kind`/`agent`, `branch`, `asset_kind`,
        // `market_kind`, `sector`. Map each to the top-nav kind the
        // shell's `ecoagent:navigate` listener expects.
        const NAV = {
            agent_kind:       'archetype',
            agent:            'archetype',
            agent_instance:   'agent',
            asset_kind:       'asset_kind',
            market_archetype: 'market',
            market_kind:      'market_kind',
            branch:           'market',
            sector:           'sector',
            sector_kind:      'sector',
        };
        const rows = items.map((v) => {
            const sev   = v.severity === 'error' ? 'error' : 'warning';
            const navK  = NAV[v.entity_kind] || '';
            const navId = v.entity_id || '';
            const navAttr = (navK && navId)
                ? ` data-nav-kind="${esc(navK)}" data-nav-id="${esc(navId)}"`
                : '';
            const linkClass = (navK && navId) ? ' ea-mi__row--link' : '';
            const where = v.entity_kind
                ? `<code>${esc(v.entity_kind)}${v.entity_id ? `:${esc(v.entity_id)}` : ''}</code>`
                : '';
            const attr = v.attribute ? ` <span class="ea-mi__badge">${esc(v.attribute)}</span>` : '';
            return `
                <li class="ea-mi__row ea-mi__row--contract ea-mi__row--${sev}${linkClass}"${navAttr}>
                    <div class="ea-mi__row-head">
                        <span class="ea-mi__badge ea-mi__badge--${sev}">${sev}</span>
                        ${where}${attr}
                    </div>
                    <div class="ea-mi__msg">${esc(v.message || '(no message)')}</div>
                </li>`;
        }).join('');
        const subtitle = errs && warns
            ? `${errs} error${errs === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`
            : (errs ? `${errs} error${errs === 1 ? '' : 's'}`
                    : `${warns} warning${warns === 1 ? '' : 's'}`);
        return `
            <section class="ea-mi__section">
                <h4 class="ea-mi__section-title">Contract violations (${subtitle})</h4>
                <p class="ea-mi__section-hint">
                    Schema and base-class checks from the project-wide
                    validator. Errors block world-build; warnings ride
                    alongside. Click a row to jump to the offending
                    entity.
                </p>
                <ul class="ea-mi__list">${rows}</ul>
            </section>
        `;
    }

    _renderSfcSection(items) {
        const sectorItems = items.filter((s) => s.scope === 'sector');
        const kindItems   = items.filter((s) => s.scope !== 'sector');
        // 2-dp with thousands separators — the exact "off by" on the row head
        // stays full-precision; these read-along amounts favour legibility.
        const fmtAmt = (x) => Number(x || 0).toLocaleString(undefined, {
            minimumFractionDigits: 2, maximumFractionDigits: 2,
        });
        // One contributor = one ARCHETYPE's net position in this kind/sector.
        // A kind breach has no single culprit (the counterparty is what's
        // MISSING), so we name who holds vs who owes and let the gap speak.
        const contribRow = (c) => {
            if (c.more) {
                const sign = c.net >= 0 ? '+' : '−';
                return `<li class="ea-mi__contrib ea-mi__contrib--more">
                            <span class="ea-mi__contrib-agent">${esc(c.agent)}</span>
                            <span class="ea-mi__contrib-amt">${sign}${fmtAmt(Math.abs(c.net))}</span>
                        </li>`;
            }
            const owes = c.side === 'owes';
            return `<li class="ea-mi__contrib">
                        <code class="ea-mi__contrib-agent">${esc(c.agent)}</code>
                        <span class="ea-mi__contrib-side ea-mi__contrib-side--${owes ? 'owes' : 'holds'}">${owes ? 'owes' : 'holds'}</span>
                        <span class="ea-mi__contrib-amt">${fmtAmt(Math.abs(c.net))}</span>
                        <span class="ea-mi__contrib-type">${owes ? 'liability' : 'asset'}</span>
                    </li>`;
        };
        // The residual (row `net`) is exactly the unmatched amount. Spell out
        // what's missing in the reader's terms.
        const summaryText = (s) => {
            const amt = fmtAmt(Math.abs(s.net));
            if (s.scope === 'sector') {
                return `${amt} unreconciled — this sector's equity entry is stale.`;
            }
            return s.net < 0
                ? `${amt} of ${s.label} owed with no matching holder.`
                : `${amt} of ${s.label} held with no matching issuer.`;
        };
        const renderRow = (s) => {
            const sign = s.net >= 0 ? '+' : '';
            const delta = s.net.toFixed(6).replace(/\.?0+$/, '');
            const scopeWord = s.scope === 'sector' ? 'this sector' : 'economy-wide';
            const contribs = Array.isArray(s.contributors) ? s.contributors : [];
            // Kind breaches are the real-leak case the user is chasing — open
            // the who-holds/owes breakdown by default so the agents show
            // without a click. Sector rows (often just stale equity) stay
            // collapsed to keep the popover compact.
            const open = s.scope !== 'sector' ? ' open' : '';
            const breakdown = contribs.length
                ? `<details class="ea-mi__sfc-break"${open}>
                        <summary class="ea-mi__sfc-break-toggle">who holds / owes this</summary>
                        <ul class="ea-mi__contribs">${contribs.map(contribRow).join('')}</ul>
                        <p class="ea-mi__contrib-sum">→ ${esc(summaryText(s))}</p>
                   </details>`
                : '';
            return `
                <li class="ea-mi__row ea-mi__row--sfc">
                    <div class="ea-mi__sfc-head">
                        <span class="ea-mi__row-name">
                            <code>${esc(s.label)}</code>
                            <span class="ea-mi__sfc-scope">${esc(scopeWord)}</span>
                        </span>
                        <span class="ea-mi__row-detail">off by ${sign}${esc(delta)}</span>
                    </div>
                    ${breakdown}
                </li>`;
        };
        const sectorRows = sectorItems.map(renderRow).join('');
        const kindRows   = kindItems  .map(renderRow).join('');
        // Pre-run state — the balance sheet is aggregated from archetype
        // templates and the world-build pairing step (`_balance_initial_books`)
        // hasn't run yet. Flag this so users know the numbers will likely
        // net to zero once they hit Run.
        const preRunHint = (this._lastIssues || {}).preRun
            ? `<p class="ea-mi__section-hint ea-mi__section-hint--prerun">
                   <span class="ea-mi__badge">pre-run estimate</span>
                   Customer deposits and bank reserves are paired at world
                   build time — these usually resolve to zero on the first
                   tick.
               </p>`
            : '';
        return `
            <section class="ea-mi__section">
                <h4 class="ea-mi__section-title">SFC unbalanced (${items.length})</h4>
                <p class="ea-mi__section-hint">
                    Each row fails the accounting identity A − L − E = 0.
                    An <em>economy-wide</em> row means that asset (e.g.
                    deposits) has a claim with no matching counterparty; a
                    <em>this sector</em> row means one sector's books don't
                    balance. Expand a row to see which agents hold vs. owe it.
                </p>
                ${preRunHint}
                <ul class="ea-mi__list">${sectorRows}${kindRows}</ul>
            </section>
        `;
    }

    _renderCodeSection(items) {
        const rows = items.map((e) => {
            const where = (e.tick != null) ? `t${e.tick}` : '';
            const src   = e.source || (e.scope === 'world' ? 'world' : 'agent');
            const tb = e.traceback
                ? `<details class="ea-mi__tb"><summary>traceback</summary><pre>${esc(e.traceback)}</pre></details>`
                : '';
            return `
                <li class="ea-mi__row ea-mi__row--code">
                    <div class="ea-mi__row-head">
                        ${where ? `<span class="ea-mi__tick">${esc(where)}</span>` : ''}
                        <code class="ea-mi__src">${esc(src)}</code>
                    </div>
                    <div class="ea-mi__msg">${esc(e.message || '(no message)')}</div>
                    ${tb}
                </li>`;
        }).join('');
        return `
            <section class="ea-mi__section">
                <h4 class="ea-mi__section-title">Agent code errors (${items.length})</h4>
                <p class="ea-mi__section-hint">
                    Exceptions caught in agents' loop bodies (observe / execute /
                    adjust / flows). The agent is skipped for that tick and the
                    rest of the world keeps running.
                </p>
                <ul class="ea-mi__list">${rows}</ul>
            </section>
        `;
    }
}


function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

/** "12s ago", "3 min ago", "2 h ago", "yesterday" — for the
 *  scenario-status indicator's last-run timestamp. */
function _formatRelativeTime(unixTs) {
    const now = Date.now() / 1000;
    const dt = Math.max(0, now - Number(unixTs || 0));
    if (dt < 5)     return 'just now';
    if (dt < 60)    return `${Math.round(dt)}s ago`;
    if (dt < 3600)  return `${Math.round(dt / 60)} min ago`;
    if (dt < 86400) return `${Math.round(dt / 3600)} h ago`;
    return new Date(Number(unixTs) * 1000).toLocaleDateString();
}
