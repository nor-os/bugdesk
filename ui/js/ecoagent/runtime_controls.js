/**
 * runtime_controls.js — global Run/Step/Pause/Reset buttons + tick display
 * mounted into Ecosim's existing workspace top bar.
 *
 * Why here, not on the SFC page: the controls are now reachable from
 * every mode. Edits on Agents / Markets / Worlds all play against the
 * same world; the controls live alongside the breadcrumb so a Run
 * triggered while editing an archetype just works.
 *
 * Four distinct buttons, each enabled only when its action makes sense:
 *
 *                       no world     idle+world    running
 *   ▶  Run               ENABLED      ENABLED       disabled
 *   ⏭  Step              ENABLED      ENABLED       disabled
 *   ⏸  Pause             disabled     disabled      ENABLED  → world_run_stop
 *                                                              (world stays at current tick;
 *                                                              click Run again to resume)
 *   ⟲  Reset             disabled     ENABLED       disabled → world_reset (drop to t=0)
 *
 *   #sim-tick (in bar-left, next to #sim-status)
 *                            →  tick "T / target"   while running
 *                               tick "T"            when idle with a world
 *                               "—"                 when no world loaded
 *                               (the legacy topbar #current-time-display
 *                               was removed when this moved to the bar;
 *                               sits beside #sim-status, both describing
 *                               simulation state, leaving the bar-right
 *                               edge to the notification-history bell)
 *
 * Push, not poll: the Python runner pushes "run:tick" / "run:completed"
 * / "run:error" via `window.__ecoagentPush` (pywebview evaluate_js).
 * Throttling is in Python (≤20 emits/sec). On the JS side the time
 * display updates on every push; the shell bus' `ecoagent:run:tick`
 * (which Agents / Markets / SFC pages listen to) is emitted every
 * 10 ticks so page-level refreshes stay coarse.
 */

import { getSetting } from '../core/settings.js';
import { isBatchModeOn, setBatchMode } from './scenario_widget.js';
import { toastInfo } from './ui/toast.js';
import { getBatchWorkersWindow } from './ui/batch_workers_window.js';

export function installRuntimeControls({ eventBus, logger } = {}) {
    const log = logger ?? { info(){}, warn(){}, error(){}, debug(){} };
    const ctl = new RuntimeControls(eventBus, log);
    ctl.install();
    return ctl;
}


class RuntimeControls {
    constructor(eventBus, log) {
        this.eventBus = eventBus;
        this.log = log;
        this._running = false;
        this._starting = false;         // Run claimed, POST in flight (pre-run)
        this._active  = false;          // is a world currently loaded?
        this._runDonePromise = null;
        this._runDoneResolve = null;
        // Sentinel: any tick is far enough away from -Infinity to
        // trigger the first bus emit immediately, instead of swallowing
        // the first `stride` ticks of every run. Without this the
        // bottom panel + tabs would stay frozen on pre-run state for
        // the first ~10 ticks of every run (worse on short runs, where
        // no tick events fired at all).
        this._lastBusEmitTick = Number.NEGATIVE_INFINITY;
        // Wall-clock companion to _lastBusEmitTick: the bus tick also
        // fires on a time floor so slow-tick runs still feel live.
        this._lastBusEmitMs = Number.NEGATIVE_INFINITY;
        this._installPushHandler();
    }

    _installPushHandler() {
        // Python calls window.__ecoagentPush(event, payload). We route
        // run-related events to this controller. Keep other events
        // (future use) on the shell bus too so any consumer can listen.
        const prev = window.__ecoagentPush;
        window.__ecoagentPush = (event, payload) => {
            // Diagnostic log — leave on so the user can verify in
            // DevTools that the push chain is actually firing during
            // a batch run. Filter the console for "ecoagent push" to
            // confirm events reach the JS side.
            try { console.debug('[ecoagent push]', event, payload); }
            catch { /* ignore */ }
            try {
                if (event === 'run:tick')      this._onPushTick(payload);
                else if (event === 'run:completed') this._onPushCompleted(payload);
                else if (event === 'run:error')     this._onPushError(payload);
                else if (event === 'batch:completed') this._onPushBatchCompleted(payload);
                this.eventBus?.emit?.(`ecoagent:${event}`, payload);
            } catch (err) {
                this.log.warn?.('push handler failed', { event, err });
            }
            // Chain to a prior handler if one existed.
            try { prev?.(event, payload); } catch { /* ignore */ }
        };
    }

    _onPushTick({ current, target } = {}) {
        this._renderTick({ active: true, running: true, current, target });
        // Coarse refresh signal for the live UI (dashboard plots, Agents/
        // Markets tables). Two gates, fire on EITHER:
        //   • stride ticks elapsed — keeps fast runs from over-emitting
        //     (N is user-configurable via ecoagent.run.coarseRefreshTicks);
        //   • MAX_BUS_EMIT_GAP_MS of wall time elapsed — keeps SLOW runs
        //     responsive. A heavy economy doing only a few ticks/sec would
        //     otherwise wait stride×tick_period (multiple seconds) between
        //     emits, so the dashboard felt like it barely auto-updated.
        // Downstream consumers self-throttle (the dashboard awaits each
        // _pushDataToTiles before re-arming its 200ms coalescer), so the
        // time floor can't pile work up — it just removes the dead air.
        const MAX_BUS_EMIT_GAP_MS = 400;
        const cur = Number(current) || 0;
        const stride = Math.max(1, Number(getSetting('ecoagent.run.coarseRefreshTicks')) || 10);
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const ticksDue = cur - this._lastBusEmitTick >= stride;
        const timeDue = now - (this._lastBusEmitMs ?? Number.NEGATIVE_INFINITY) >= MAX_BUS_EMIT_GAP_MS;
        if (ticksDue || timeDue) {
            this._lastBusEmitTick = cur;
            this._lastBusEmitMs = now;
            this.eventBus?.emit?.('ecoagent:run:tick', { tick: cur, target });
        }
    }

    _onPushCompleted(payload) {
        // Sentinel: any tick is far enough away from -Infinity to
        // trigger the first bus emit immediately, instead of swallowing
        // the first `stride` ticks of every run. Without this the
        // bottom panel + tabs would stay frozen on pre-run state for
        // the first ~10 ticks of every run (worse on short runs, where
        // no tick events fired at all).
        this._lastBusEmitTick = Number.NEGATIVE_INFINITY;
        this._lastBusEmitMs = Number.NEGATIVE_INFINITY;
        // Mirror final state so the time display reads the true tick.
        const status = {
            active: true, running: false,
            current: payload?.current, tick: payload?.current,
            target:  payload?.target,
        };
        this._renderTick(status);
        // In a batch run, the *active* scenario's run:completed fires
        // while other scenarios are still working — releasing the Run
        // button here would let the user re-click and hit the "batch
        // already in progress" guard. Wait for batch:completed instead.
        if (this._inBatchRun) return;
        if (this._runDoneResolve) {
            this._runDoneResolve(payload || {});
            this._runDoneResolve = null;
            this._runDonePromise = null;
        }
    }

    _onPushBatchCompleted(payload) {
        // Closes out a batch run: the Run button has been parked since
        // _onRun, regardless of when the active scenario finished.
        this._inBatchRun = false;
        if (this._runDoneResolve) {
            this._runDoneResolve(payload || {});
            this._runDoneResolve = null;
            this._runDonePromise = null;
        }
    }

    _onPushError(payload) {
        this.log.warn?.('world run error', payload);
    }

    /** Mirror the scenario widget's batch-mode flag on the Run button so
     *  the user has a direct visual cue (tooltip + class) on the actual
     *  control they'll click. Called at install + whenever the toggle
     *  flips. */
    _refreshRunBtnForBatch(btn) {
        const target = btn || this._startBtn;
        if (!target) return;
        const on = isBatchModeOn();
        target.classList.toggle('ea-run-btn--batch', on);
        target.dataset.tooltip = on
            ? 'Run every scenario in turn (N ticks each)'
            : 'Run N ticks';
        target.title = target.dataset.tooltip;
    }

    /** Re-apply the batch-on/off styling to both the Run button AND the
     *  toggle button that sits next to it, so the pair reads as a single
     *  state-bearing control. */
    _refreshBatchControls() {
        const on = isBatchModeOn();
        this._refreshRunBtnForBatch(this._startBtn);
        const t = this._batchBtn;
        if (t) {
            t.classList.toggle('ea-batch-toggle--on', on);
            t.setAttribute('aria-pressed', on ? 'true' : 'false');
            t.dataset.tooltip = on
                ? 'Batch mode is ON — click to run only the active scenario instead'
                : 'Batch mode — when on, Run runs every scenario in turn';
            t.title = t.dataset.tooltip;
        }
        const cluster = t?.parentElement;
        cluster?.classList?.toggle('ea-run-cluster--batch', on);
    }

    _setBatchRunningClass(running) {
        const t = this._batchBtn;
        if (!t) return;
        t.classList.toggle('ea-batch-toggle--running', !!running);
        const cluster = t.parentElement;
        cluster?.classList?.toggle('ea-run-cluster--running', !!running);
        // Reset the inline progress badge whenever the batch state
        // transitions. While running, _onBatchProgress updates it.
        if (!running) this._setBatchProgressBadge(null);
    }

    /** Show / hide the small "X/N" badge on the batch toggle that
     *  tells the user how many scenarios have completed. Driven by
     *  the batch:progress push events; one source of truth visible
     *  on the actual control the user clicked, independent of the
     *  floating BatchProgressTracker toast. */
    _setBatchProgressBadge(payload) {
        const t = this._batchBtn;
        if (!t) return;
        let badge = t.querySelector('.ea-batch-toggle__count');
        if (!payload) { badge?.remove(); return; }
        const completed = payload.completed ?? 0;
        const total = payload.total ?? 0;
        if (total === 0) { badge?.remove(); return; }
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'ea-batch-toggle__count';
            t.appendChild(badge);
        }
        badge.textContent = `${completed}/${total}`;
        t.title = `Batch running — ${completed} of ${total} scenarios complete`;
    }

    async _onToggleBatchMode() {
        const next = !isBatchModeOn();
        // Flipping batch mode changes what a Run actually does. If a
        // world is already running or carries leftover ticks from a
        // prior single-scenario run, those would mix awkwardly with
        // the new mode (e.g. batch overlays a stale active-world line
        // against fresh scenario runs). Reset the world FIRST so the
        // next Run starts from a clean slate regardless of direction.
        try {
            await window.pywebview?.api?.world_reset?.();
            // The reset emits run:completed{kind:'reset'} which the
            // tick poll / push handler will pick up to clear the
            // displayed tick. No extra UI work needed here.
        } catch (err) {
            this.log.warn?.('world_reset before batch toggle failed', { err });
        }
        setBatchMode(next);
        this._refreshBatchControls();
        this.eventBus?.emit?.('ecoagent:batch-mode:changed', { on: next });
        toastInfo(
            next ? 'Batch mode on' : 'Batch mode off',
            next
                ? 'Run will execute every scenario in turn using the current tick count. World reset to t=0.'
                : 'Run will execute only the active scenario. World reset to t=0.',
        );
    }

    install() {
        const topbar = document.querySelector('.workspace-top-bar');
        const bar = document.querySelector('.workspace-top-bar .sim-controls .menu-bar');
        const start = document.getElementById('start-button');
        const pause = document.getElementById('pause-button');
        const stop  = document.getElementById('stop-button');
        if (!topbar || !bar || !start || !pause || !stop) {
            this.log.warn?.('runtime-controls: topbar simulation controls missing — skipping');
            return;
        }
        // Tick readout lives in the global bottom bar's bar-right slot
        // (#sim-tick, created by application_shell._buildGlobalBottomBar).
        // The legacy topbar `.time-display` wrapper is redundant — drop
        // it so there's exactly one place that shows the world clock.
        this._timeEl = document.getElementById('sim-tick');

        // Reorder topbar children: breadcrumb FIRST (leftmost), then
        // sim controls. Ecosim builds them in the opposite order; we fix
        // it at install so the layout is consistent regardless of which
        // mode is active. The Ecosim time-display wrapper (now superseded
        // by #sim-tick on the status bar) is removed outright.
        const breadcrumb = topbar.querySelector('.topbar-breadcrumb');
        const simCtl     = topbar.querySelector('.sim-controls');
        const timeDisp   = topbar.querySelector('.time-display');
        timeDisp?.remove();
        if (breadcrumb) topbar.insertBefore(breadcrumb, topbar.firstChild);
        if (simCtl && breadcrumb) topbar.insertBefore(simCtl, breadcrumb.nextSibling);

        // Rewire the existing Ecosim buttons. We replace listeners by
        // cloning so any prior bindings (Ecosim's own no-op handlers)
        // don't fire.
        const cloneAndReplace = (el) => {
            const n = el.cloneNode(true);
            el.replaceWith(n);
            return n;
        };
        const startBtn = cloneAndReplace(start);
        const pauseBtn = cloneAndReplace(pause);
        const stopBtn  = cloneAndReplace(stop);

        startBtn.dataset.tooltip = 'Run N ticks';
        startBtn.addEventListener('click', () => this._onRun());

        // Batch-mode toggle, fused with Run.
        //
        // The two buttons live in one wrapper (`.ea-run-cluster`) and
        // share a border, so they read as one paired control: a small
        // toggle that picks WHAT Run will execute (this scenario vs every
        // scenario in turn) + the wide Run arrow itself. When batch is on,
        // both sides light up green; flipping the toggle also retitles
        // the Run button so the consequence is obvious.
        const runCluster = document.createElement('div');
        runCluster.className = 'ea-run-cluster';
        startBtn.parentNode.insertBefore(runCluster, startBtn);
        const batchOn = isBatchModeOn();
        const batchBtn = document.createElement('button');
        batchBtn.id = 'ea-batch-toggle';
        batchBtn.type = 'button';
        batchBtn.className = 'ea-batch-toggle has-tooltip'
                           + (batchOn ? ' ea-batch-toggle--on' : '');
        batchBtn.setAttribute('aria-pressed', batchOn ? 'true' : 'false');
        batchBtn.dataset.tooltip = 'Batch mode — when on, Run runs every scenario in turn';
        batchBtn.title = batchBtn.dataset.tooltip;
        batchBtn.innerHTML = '<span class="material-symbols-outlined">stacks</span>';
        batchBtn.addEventListener('click', () => this._onToggleBatchMode());
        runCluster.appendChild(batchBtn);
        runCluster.appendChild(startBtn);
        this._batchBtn = batchBtn;
        this._startBtn = startBtn;

        // Initial mirror — class + tooltip on Run.
        this._refreshRunBtnForBatch(startBtn);
        this.eventBus?.on?.('ecoagent:batch-mode:changed',
            () => this._refreshBatchControls());
        // Spinner on the toggle while a batch is in flight.
        this.eventBus?.on?.('ecoagent:batch:started',
            () => this._setBatchRunningClass(true));
        this.eventBus?.on?.('ecoagent:batch:completed',
            () => this._setBatchRunningClass(false));
        // Live X/N badge on the toggle so the user always sees batch
        // progress directly on the control they pressed, regardless of
        // whether the floating BatchProgressTracker toast is visible.
        this.eventBus?.on?.('ecoagent:batch:progress',
            (payload) => this._setBatchProgressBadge(payload));

        // Pause = cooperative stop. The runner exits at the next tick
        // boundary; the world stays at its current tick. Clicking Run
        // again continues from there for N more ticks. Enabled only
        // while a run is in flight.
        pauseBtn.dataset.tooltip = 'Pause the running loop';
        pauseBtn.title = 'Pause the running loop';
        // Make sure the pause icon is the right one — Ecosim's button
        // sometimes ships a different glyph by default.
        {
            const ic = pauseBtn.querySelector('.material-symbols-outlined');
            if (ic) ic.textContent = 'pause';
        }
        pauseBtn.addEventListener('click', () => this._onPause());

        // Reset = drop to t=0. Only enabled when a world exists and no
        // run is in flight. Always shows the restart icon.
        {
            const ic = stopBtn.querySelector('.material-symbols-outlined');
            if (ic) ic.textContent = 'restart_alt';
        }
        stopBtn.dataset.tooltip = 'Reset world to t=0';
        stopBtn.title = 'Reset world to t=0';
        stopBtn.addEventListener('click', () => this._onReset());

        // Inject a Step button — Ecosim's bar doesn't have one.
        // Sits immediately after Start so the natural reading order is
        // [Run] [Step] [Stop] [Reset]. Always clickable: during a run
        // _onStep no-ops cleanly; outside a run it advances one tick
        // (creating a world if needed).
        const stepBtn = document.createElement('button');
        stepBtn.id = 'ea-step-button';
        stepBtn.className = 'has-tooltip';
        stepBtn.dataset.tooltip = 'Advance one tick';
        stepBtn.innerHTML = '<span class="material-symbols-outlined control-icon control-icon--step">skip_next</span>';
        stepBtn.addEventListener('click', () => this._onStep());
        startBtn.parentNode.insertBefore(stepBtn, startBtn.nextSibling);

        // Inline ticks input — Run uses this value directly, no modal.
        // Persisted across reloads via localStorage. The "∞" toggle next
        // to it switches Run into infinite mode: the ticks input
        // disables and the runner loops until Pause is hit.
        const wrap = document.createElement('label');
        wrap.className = 'ea-ticks-input has-tooltip';
        wrap.dataset.tooltip = 'Number of ticks for Run (toggle ∞ for an indefinite run)';
        const initialInfinite = this._loadInfinite();
        wrap.innerHTML = `
            <span class="ea-ticks-input__label">ticks</span>
            <input type="number" id="ea-ticks-input" min="1" step="1" value="${this._loadTicks()}" ${initialInfinite ? 'disabled' : ''} />
            <button type="button" id="ea-infinite-toggle"
                    class="ea-infinite-toggle ${initialInfinite ? 'ea-infinite-toggle--on' : ''}"
                    title="Toggle infinite run — stops only when you click Pause">∞</button>
        `;
        bar.appendChild(wrap);
        const ticksEl = wrap.querySelector('#ea-ticks-input');
        ticksEl.addEventListener('change', () => this._saveTicks(ticksEl.value));
        ticksEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this._onRun(); }
        });
        const infBtn = wrap.querySelector('#ea-infinite-toggle');
        infBtn.addEventListener('click', () => {
            const next = !this._infinite;
            this._setInfinite(next);
        });

        this._startBtn = startBtn;
        this._pauseBtn = pauseBtn;
        this._stopBtn  = stopBtn;
        this._stepBtn  = stepBtn;
        this._ticksEl  = ticksEl;
        this._infBtn   = infBtn;
        this._infinite = initialInfinite;

        // Ensure the controls stay visible across EcoAgent modes —
        // Ecosim hides them when leaving its simulation-run mode.
        this._forceVisible();
        this.eventBus?.on?.('extra-mode:changed', () => this._forceVisible());
        this.eventBus?.on?.('shell:mode-changed', () => {
            // Run after Ecosim's _switchMode hides our bits.
            queueMicrotask(() => this._forceVisible());
        });

        this._initialStatusRefresh();
        this._setRunning(false);
    }

    _forceVisible() {
        for (const el of [this._startBtn, this._pauseBtn, this._stopBtn,
                          this._stepBtn]) {
            if (el) el.style.display = '';
        }
        // #sim-tick lives in the status bar at the bottom, not in the
        // topbar — re-show it independently so nothing in the chrome
        // hides the world clock.
        if (this._timeEl) this._timeEl.style.display = '';
        const sim = document.querySelector('.workspace-top-bar .sim-controls');
        if (sim) sim.style.display = '';
        const topbar = document.querySelector('.workspace-top-bar');
        if (topbar) topbar.style.display = '';
    }

    async _initialStatusRefresh() {
        try {
            const status = await window.pywebview?.api?.world_run_status?.();
            this._renderTick(status);
        } catch { /* no world yet */ }
    }

    _loadTicks() {
        // Per-user last-used value wins; first-run falls back to the
        // global ecoagent.run.defaultTicks setting (configurable on the
        // EcoAgent settings page).
        const seed = Math.max(1,
            Math.floor(Number(getSetting('ecoagent.run.defaultTicks')) || 100));
        try {
            const raw = localStorage.getItem('ecoagent.runTicks');
            const n = Number(raw);
            return Number.isFinite(n) && n > 0 ? Math.floor(n) : seed;
        } catch { return seed; }
    }

    _saveTicks(v) {
        const n = Math.max(1, Math.floor(Number(v) || 0));
        try { localStorage.setItem('ecoagent.runTicks', String(n)); } catch { /* quota */ }
    }

    _loadInfinite() {
        try { return localStorage.getItem('ecoagent.runInfinite') === '1'; }
        catch { return false; }
    }

    _setInfinite(on) {
        this._infinite = !!on;
        try { localStorage.setItem('ecoagent.runInfinite', on ? '1' : '0'); }
        catch { /* quota */ }
        if (this._infBtn) {
            this._infBtn.classList.toggle('ea-infinite-toggle--on', this._infinite);
        }
        if (this._ticksEl) {
            // Disable + dim the ticks field while ∞ is on so it's obvious
            // the number is ignored.
            this._ticksEl.disabled = !!this._infinite || !!this._running;
        }
    }

    async _onRun() {
        // Re-entrancy guard. The Run button isn't disabled until _setRunning
        // runs AFTER the world_run_async await below, and for a heavy world
        // that POST blocks for seconds while Python rebuilds. A second click
        // (or Enter) in that window used to fire a SECOND concurrent run — two
        // threads stepping one non-thread-safe world (drifting T/target, wrong
        // final tick, ProjectLoadError). The server now claims the run
        // atomically and rejects the duplicate, but bail here too to skip the
        // wasted round-trip and the spurious "already in progress" toast.
        if (this._running || this._starting) return;
        this._starting = true;
        // Reflect the click IMMEDIATELY (spinner + disabled), before the
        // world_run_async POST — for a heavy world that call blocks for
        // seconds while Python rebuilds, and without this the button looks
        // dead the whole time ("I clicked but nothing happened").
        this._syncControls();
        try {
            await this._onRunImpl();
        } finally {
            this._starting = false;
            this._syncControls();
        }
    }

    async _onRunImpl() {
        // Infinite mode → pass 0 to world_run_async. The backend loops
        // until Pause is clicked. Finite mode reads + persists the
        // inline ticks input.
        let runTicks;
        if (this._infinite) {
            runTicks = 0;
        } else {
            runTicks = Math.max(1, Math.floor(Number(this._ticksEl?.value) || 100));
            this._saveTicks(runTicks);
        }
        // Arm the completion promise BEFORE asking Python to start —
        // the runner can push run:completed before world_run_async
        // even returns on very short runs.
        // Sentinel: any tick is far enough away from -Infinity to
        // trigger the first bus emit immediately, instead of swallowing
        // the first `stride` ticks of every run. Without this the
        // bottom panel + tabs would stay frozen on pre-run state for
        // the first ~10 ticks of every run (worse on short runs, where
        // no tick events fired at all).
        this._lastBusEmitTick = Number.NEGATIVE_INFINITY;
        this._runDonePromise = new Promise((resolve) => {
            this._runDoneResolve = resolve;
        });
        // Batch-mode hand-off: the scenario widget owns a sticky toggle
        // that flips Run from "advance the active world" to "run every
        // scenario in turn". Infinite mode doesn't make sense for a
        // batch (each scenario has a finite tick budget), so we fall
        // back to a 100-tick default there.
        const batchMode = isBatchModeOn();
        this._inBatchRun = batchMode;
        const apiName = batchMode ? 'scenarios_run_batch' : 'world_run_async';
        const apiArg  = batchMode
            ? Math.max(1, this._infinite ? 100 : runTicks)
            : runTicks;
        try {
            const res = await window.pywebview?.api?.[apiName]?.(apiArg);
            if (res?.ok === false) {
                console.error(`[runtime-controls] ${apiName} refused:`, res.error);
                this.log.warn?.(res.error);
                this._runDoneResolve?.({}); this._runDoneResolve = null;
                this._runDonePromise = null;
                return;
            }
            if (!res) {
                console.error(`[runtime-controls] ${apiName} unavailable on pywebview.api`);
                this._runDoneResolve?.({}); this._runDoneResolve = null;
                this._runDonePromise = null;
                return;
            }
            // Batch mode: open the workers window IMMEDIATELY from the
            // same click handler — no reliance on push events
            // arriving. Push events (batch:progress / batch:scenario /
            // batch:completed) drive the rest of the updates.
            if (batchMode) {
                try {
                    const w = getBatchWorkersWindow();
                    console.debug('[runtime-controls] batch workers window handle?', !!w);
                    if (w) {
                        const seed = (res?.scenarios || []).map((s) => ({
                            id:    s.id == null ? '' : String(s.id),
                            label: s.label || (s.id || 'Baseline'),
                        }));
                        w.openForBatch(seed);
                    } else {
                        console.error('[runtime-controls] batch workers window NOT installed — extra_modes never ran installBatchWorkersWindow');
                    }
                } catch (err) {
                    console.error('[runtime-controls] open batch workers window failed', err);
                }
            }
        } catch (err) {
            console.error(`[runtime-controls] ${apiName} threw:`, err);
            this.log.warn?.(`${apiName} failed`, { err });
            this._runDoneResolve?.({}); this._runDoneResolve = null;
            this._runDonePromise = null;
            return;
        }
        this._setRunning(true);
        this.eventBus?.emit?.('ecoagent:run:started', { ticks: runTicks, batch: batchMode });
        // Wait for completion via either path:
        //   - Python's push of run:completed (pywebview mode), or
        //   - the status poll below seeing running === false (HTTP-bridge
        //     mode, where evaluate_js can't reach the browser).
        // Both call _runDoneResolve; whichever wins first resolves the
        // promise. The poll is idempotent with the push handler.
        this._startStatusPoll();
        await this._runDonePromise;
        this._stopStatusPoll();
        this._setRunning(false);
        this.eventBus?.emit?.('ecoagent:run:completed', { ticks: runTicks });
    }

    _startStatusPoll() {
        this._stopStatusPoll();
        const tick = async () => {
            if (!this._runDoneResolve) return;   // already completed
            try {
                const status = await window.pywebview?.api?.world_run_status?.();
                if (status) {
                    this._renderTick(status);
                    const cur = Number(status.current) || 0;
                    const stride = Math.max(1,
                        Number(getSetting('ecoagent.run.coarseRefreshTicks')) || 10);
                    if (cur - this._lastBusEmitTick >= stride) {
                        this._lastBusEmitTick = cur;
                        this.eventBus?.emit?.('ecoagent:run:tick', {
                            tick: cur, target: status.target,
                        });
                    }
                    // In batch mode, the active scenario's running=false
                    // only signals THAT scenario has finished. Defer
                    // resolution until the whole batch reports complete
                    // so the Run button doesn't re-arm mid-batch.
                    let batchStillRunning = false;
                    if (this._inBatchRun) {
                        try {
                            const summary = await window.pywebview?.api
                                ?.scenarios_results_summary?.();
                            batchStillRunning = !!summary?.batch?.running;
                        } catch { /* fall through — best effort */ }
                    }
                    if (status.running === false && !batchStillRunning) {
                        // Run finished — resolve the wait promise here so
                        // the HTTP-bridge path doesn't hang forever.
                        this._inBatchRun = false;
                        const resolve = this._runDoneResolve;
                        this._runDoneResolve = null;
                        this._runDonePromise = null;
                        resolve?.(status);
                        return;
                    }
                }
            } catch (err) {
                console.warn('[runtime-controls] status poll failed', err);
            }
            this._statusPollTimer = setTimeout(tick, 200);
        };
        this._statusPollTimer = setTimeout(tick, 200);
    }

    _stopStatusPoll() {
        if (this._statusPollTimer) {
            clearTimeout(this._statusPollTimer);
            this._statusPollTimer = null;
        }
    }

    /**
     * Surface a world-runner error to the user. Fires the Ecosim notification
     * system via `notification:show`, plus a console.error. De-duplicates so
     * the 5Hz poll doesn't spam the same error every 200ms.
     */
    _notifyError(error, tick) {
        const text = String(error);
        if (this._lastNotifiedError === text) return;
        this._lastNotifiedError = text;
        console.error('[runtime-controls] world run error:', text);
        // The console.error always fires (a silent error is a silent
        // bug); the toast is gated on the user setting.
        if (!getSetting('ecoagent.run.showErrorToast')) return;
        const tickStr = (tick === undefined || tick === null) ? '?' : tick;
        this.eventBus?.emit?.('notification:show', {
            title: `Simulation error at tick ${tickStr}`,
            message: text,
            severity: 'error',
            persistent: true,
        });
    }

    async _onPause() {
        // Cooperative stop — the runner exits at the next tick boundary
        // and pushes run:completed, which resolves _runDonePromise. The
        // status poll also catches this in HTTP-bridge mode. No-op if
        // we're not running (button is already disabled in that state).
        if (!this._running) return;
        try {
            await window.pywebview?.api?.world_run_stop?.();
        } catch (err) {
            console.error('[runtime-controls] world_run_stop threw:', err);
        }
    }

    async _onReset() {
        // Reset = drop to t=0. Disabled while a run is in flight or when
        // no world exists — clicking would have been a no-op anyway.
        if (this._running || !this._active) return;
        try {
            const res = await window.pywebview?.api?.world_reset?.();
            if (res?.ok === false) {
                console.error('[runtime-controls] world_reset refused:', res.error);
                this.log.warn?.(res.error);
            } else if (!res) {
                console.error('[runtime-controls] world_reset unavailable on pywebview.api');
            }
        } catch (err) {
            console.error('[runtime-controls] world_reset threw:', err);
            this.log.warn?.('world_reset failed', { err });
            return;
        }
        this._active = false;
        this._renderTick({ active: false });
        this._syncControls();
        this.eventBus?.emit?.('ecoagent:run:completed', { kind: 'reset' });
    }

    async _onStep() {
        if (this._running) return;
        let stepErr = null;
        try {
            const res = await window.pywebview?.api?.world_step?.(1);
            if (res?.ok === false) {
                stepErr = res.error || 'world_step refused';
                console.error('[runtime-controls] world_step refused:', stepErr);
            } else if (!res) {
                stepErr = 'world_step unavailable';
                console.error('[runtime-controls] world_step unavailable on pywebview.api');
            }
        } catch (err) {
            stepErr = String(err?.message || err);
            console.error('[runtime-controls] world_step threw:', err);
        }
        // Always refresh the display — step() bumps tick before the work,
        // so even on failure the user should see the new tick + an error
        // indicator, not a stale display.
        try {
            const status = await window.pywebview?.api?.world_run_status?.();
            if (stepErr && status) status.error = stepErr;
            this._renderTick(status);
        } catch (err) {
            console.error('[runtime-controls] world_run_status threw after step:', err);
            this._renderTick({ active: true, running: false, error: stepErr || String(err) });
        }
        this.eventBus?.emit?.('ecoagent:run:tick', { source: 'step' });
    }

    _setRunning(flag) {
        this._running = flag;
        // A run necessarily implies a world exists — track it so Reset
        // is enabled after the run ends.
        if (flag) this._active = true;
        this._syncControls();
    }

    /**
     * Drive every button's enabled state + tooltip from the two flags
     * `_running` and `_active`. One place so the four buttons can't get
     * out of sync.
     *
     *                       no world     idle+world    running
     *   Run                  ENABLED      ENABLED      disabled
     *   Step                 ENABLED      ENABLED      disabled
     *   Pause                disabled     disabled     ENABLED
     *   Reset                disabled     ENABLED      disabled
     */
    _syncControls() {
        const running = !!this._running;
        const starting = !!this._starting;   // click registered, world still building
        const busy = running || starting;    // Run/Step/ticks all locked out either way
        const active  = !!this._active;

        // Ecosim's `.menu-bar` button styling keys on the `.is-disabled`
        // CLASS (see `:not(.is-disabled)` rules in main_new.css), not the
        // `:disabled` pseudo-class. We must toggle both: the property for
        // click semantics, the class for the visible dimming.
        const setBtnDisabled = (btn, disabled, tip) => {
            if (!btn) return;
            btn.disabled = disabled;
            btn.classList.toggle('is-disabled', disabled);
            if (tip != null) {
                btn.dataset.tooltip = tip;
                btn.title = tip;
            }
        };

        setBtnDisabled(this._startBtn, busy,
            starting ? 'Starting…'
                     : (running ? 'A run is already in flight' : 'Run N ticks'));
        // Spinner overlay while the world builds (see .is-starting in CSS).
        // Dropped once `running` flips true — then it's just a disabled button.
        this._startBtn?.classList.toggle('is-starting', starting && !running);

        // Ticks field is disabled while running/starting OR while ∞ is toggled
        // on — all mean the value isn't read.
        if (this._ticksEl) this._ticksEl.disabled = busy || !!this._infinite;
        setBtnDisabled(this._infBtn, busy,
            running ? 'Pause the run first' : 'Run until you pause');

        setBtnDisabled(this._stepBtn, busy,
            running ? 'Pause the run first to step' : 'Advance one tick');

        setBtnDisabled(this._pauseBtn, !running,
            running
                ? 'Pause the running loop (world keeps its current tick)'
                : 'Nothing to pause — start a run first');

        // Reset: only when a world exists AND no run is in flight/starting.
        setBtnDisabled(this._stopBtn, busy || !active,
            !active
                ? 'No world to reset — run first'
                : (running ? 'Pause the run first to reset' : 'Reset world to t=0'));
    }

    _renderTick(status) {
        // Track whether a world exists so the stop button can correctly
        // show "Reset" (active world) vs disabled (no world). An error
        // still implies a world exists — keep _active true so the user
        // can reset out of the error state.
        if (status?.active === false) this._active = false;
        else if (status && (status.active || status.error
                || status.current != null || status.tick != null)) {
            this._active = true;
        }
        // The `running` field from status is authoritative — sync it too
        // so the button state matches reality even if push events were
        // missed (e.g. HTTP-bridge mode without a status poll running).
        //
        // EXCEPT during a batch run: the scenarios execute off the
        // in-process world (active_pair=None in scenarios_run_batch), so
        // world_run_status() reports running=false for the whole batch.
        // Letting that clobber _running would flip the Pause button back
        // to Run one poll-tick (~200ms) after the batch starts — the
        // "batch doesn't show Pause" bug. Batch run-state is owned by
        // _onRun/_inBatchRun and released on batch:completed (or the
        // poll's batch-summary check), so leave _running alone here while
        // a batch is in flight.
        if (status && typeof status.running === 'boolean' && !this._inBatchRun) {
            this._running = status.running;
        }
        this._syncControls();

        const el = this._timeEl;
        if (!el) return;
        // Surface a backend error visibly — without this the user just
        // sees a stalled tick counter and has no idea the runner crashed.
        if (status?.error) {
            el.textContent = `err @ t${status.tick ?? status.current ?? '?'}`;
            el.title = String(status.error);
            el.style.color = '#d9886a';
            this._notifyError(status.error, status.tick ?? status.current);
            return;
        }
        if (el.style.color) el.style.color = '';
        if (el.title)       el.title = '';
        // Clear the de-dupe guard once the error state is gone, so the
        // next error gets a fresh notification.
        this._lastNotifiedError = null;
        if (!status || !status.active) {
            el.textContent = '—';
            return;
        }
        if (status.running) {
            // target = 0 (or falsy) is the infinite-run sentinel — show
            // "T · ∞" instead of "T / 0".
            const tgt = Number(status.target);
            if (!Number.isFinite(tgt) || tgt <= 0) {
                el.textContent = `${status.current ?? '?'} · ∞`;
            } else {
                el.textContent = `${status.current ?? '?'} / ${tgt}`;
            }
        } else {
            el.textContent = String(status.tick ?? status.current ?? 0);
        }
    }
}
