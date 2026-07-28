/**
 * batch_workers_window.js — ManagedWindow showing per-scenario batch
 * progress live.
 *
 * Render model (mirrors EcoSim's WorkerProgressGrid):
 *   - One module-level state object holds the current snapshot.
 *   - Every push event updates state and calls render(), which rebuilds
 *     the entire grid HTML. No DOM diffing, no per-row querySelector
 *     juggling — the grid is always a pure function of state.
 *   - Push events: ecoagent:batch:started, :progress, :scenario,
 *     :completed. openForBatch() lets runtime_controls open + seed the
 *     grid synchronously from the same click handler that kicks the
 *     batch off, so the user never sees an empty window even if the
 *     first push event is delayed.
 */

import { ManagedWindow } from '../../ui/components/managed_window.js';

const WIN_ID = 'ea-batch-workers';

let _singleton = null;

export function installBatchWorkersWindow({ eventBus, logger } = {}) {
    if (_singleton) return _singleton;
    const log = logger ?? { warn(){}, info(){}, debug(){} };

    let win = null;
    let host = null;
    let startedAt = 0;
    let batchRunning = false;   // gates close→minimize + Stop/Pause enablement

    const state = {
        scenarios: new Map(),    // sid → { sid, label, status, completed, total, active, error }
        completedCount: 0,
        totalCount: 0,
        activeWorkers: 0,
        parallelWorkers: 0,
        finished: false,
        paused: false,
    };

    function ensureWindow() {
        if (!win) {
            host = document.createElement('div');
            host.className = 'ea-batch-workers';
            // Control buttons are rebuilt inside host.innerHTML on every
            // render, so wire them via ONE delegated listener on the (stable)
            // host element rather than per-button handlers.
            host.addEventListener('click', (e) => {
                const btn = e.target.closest?.('[data-batch-action]');
                if (!btn) return;
                const api = window.pywebview?.api;
                const action = btn.dataset.batchAction;
                if (action === 'pause')  { state.paused = true;  render(); api?.scenarios_pause_batch?.(); }
                else if (action === 'resume') { state.paused = false; render(); api?.scenarios_resume_batch?.(); }
                else if (action === 'stop')   { api?.scenarios_stop_batch?.(); }
            });
            win = new ManagedWindow({
                id: WIN_ID,
                title: 'Batch — all scenarios',
                icon: 'compare_arrows',
                content: host,
                minWidth: 420, minHeight: 240,
                defaultWidth: 560, defaultHeight: 380,
                // Never destroy the window mid-batch — minimize instead, so the
                // user can always get it back (the bottom-bar batch indicator
                // also re-opens it). Closing is only allowed once the batch is
                // done.
                beforeClose: () => {
                    if (batchRunning) { win.minimize(); return false; }
                    return true;
                },
            });
        }
        win.show();
        return win;
    }

    function fmtElapsed(ms) {
        if (!ms || ms < 0) return '';
        const s = ms / 1000;
        if (s < 60) return `${s.toFixed(1)}s`;
        const m = Math.floor(s / 60);
        const r = Math.floor(s - m * 60);
        return `${m}m ${r}s`;
    }

    function statusIcon(status) {
        switch (status) {
            case 'running':  return 'play_arrow';
            case 'complete': return 'check';
            case 'failed':   return 'error';
            default:         return 'schedule';
        }
    }

    function render() {
        if (!host) return;
        const scenarios = [...state.scenarios.values()];
        const overallPct = state.totalCount > 0
            ? Math.min(100, Math.round((state.completedCount / state.totalCount) * 100))
            : 0;
        // Scenarios run one at a time (sequential batch), so the live line is
        // scenario-centric: "X / N complete · running <label>".
        const running = [...state.scenarios.values()].find((s) => s.status === 'running');
        const summary = state.finished
            ? `Batch complete — ${state.completedCount} / ${state.totalCount} scenarios.`
            : (state.totalCount === 0
                ? 'Waiting for batch…'
                : `${state.completedCount} / ${state.totalCount} scenarios complete${running ? `  ·  running ${running.label}` : ''}`);
        const elapsed = startedAt ? fmtElapsed(Date.now() - startedAt) : '';
        const summaryTone = state.paused ? `${summary}  ·  paused` : summary;
        const controls = state.finished ? '' : `
            <div class="ea-batch-workers__controls">
                ${state.paused
                    ? '<button type="button" class="ea-batch-btn" data-batch-action="resume"><span class="material-symbols-outlined">play_arrow</span>Resume</button>'
                    : '<button type="button" class="ea-batch-btn" data-batch-action="pause"><span class="material-symbols-outlined">pause</span>Pause</button>'}
                <button type="button" class="ea-batch-btn ea-batch-btn--stop" data-batch-action="stop"><span class="material-symbols-outlined">stop</span>Stop</button>
            </div>`;

        host.innerHTML = `
            <header class="ea-batch-workers__head">
                <span class="ea-batch-workers__summary">${esc(summaryTone)}</span>
                <span class="ea-batch-workers__elapsed">${esc(elapsed)}</span>
            </header>
            <div class="ea-batch-workers__bar">
                <div class="ea-batch-workers__bar-fill" style="width: ${overallPct}%"></div>
            </div>
            ${controls}
            <div class="ea-batch-workers__grid worker-grid">
                ${scenarios.map(renderRow).join('') || '<div class="worker-grid__empty">No scenarios queued.</div>'}
            </div>
        `;
    }

    function renderRow(sc) {
        const pct = sc.total > 0
            ? Math.min(100, Math.round((sc.completed / sc.total) * 100))
            : 0;
        const statsText = sc.total > 0
            ? `${sc.completed} / ${sc.total} ticks`
            : '—';
        const isActive = sc.status === 'running';
        const itemClass =
            sc.status === 'complete' ? 'worker-grid__item worker-grid__item--complete' :
            sc.status === 'failed'   ? 'worker-grid__item worker-grid__item--failed'   :
            isActive                 ? 'worker-grid__item worker-grid__item--active'   :
                                       'worker-grid__item worker-grid__item--idle';
        const icon = statusIcon(sc.status);
        const errMarkup = sc.status === 'failed' && sc.error
            ? `<div class="worker-grid__error">${esc(sc.error)}</div>`
            : '';
        return `
            <div class="${itemClass}" data-status="${esc(sc.status)}" title="${esc(sc.label)}: ${esc(statsText)}">
                <div class="worker-grid__header">
                    <span class="worker-grid__name">
                        <span class="worker-grid__dot"></span>
                        <span class="material-symbols-outlined worker-grid__icon">${icon}</span>
                        ${esc(sc.label)}
                    </span>
                    <span class="worker-grid__stats">${esc(statsText)}</span>
                </div>
                <div class="worker-grid__bar">
                    <div class="worker-grid__bar-fill" style="width: ${pct}%"></div>
                </div>
                ${errMarkup}
            </div>
        `;
    }

    function seedScenarios(list) {
        state.scenarios.clear();
        state.finished = false;
        state.paused = false;
        batchRunning = true;   // a batch is starting
        for (const sc of (list || [])) {
            const sid = sc.id == null ? '' : String(sc.id);
            const label = sc.label || (sid || 'Baseline');
            state.scenarios.set(sid, {
                sid, label,
                status: 'pending',
                completed: 0,
                total: 0,
                active: false,
                error: null,
            });
        }
        state.completedCount = 0;
        state.totalCount = state.scenarios.size;
        state.activeWorkers = 0;
        state.parallelWorkers = 0;
    }

    function applyProgressPayload(payload) {
        const scenarios = Array.isArray(payload?.scenarios) ? payload.scenarios : [];
        const wp = Array.isArray(payload?.workerProgress) ? payload.workerProgress : [];
        for (let i = 0; i < scenarios.length; i++) {
            const sc = scenarios[i];
            const sid = sc.id == null ? '' : String(sc.id);
            let row = state.scenarios.get(sid);
            // First time we hear of this scenario — backend can race
            // ahead of openForBatch in pywebview mode. Insert on the
            // fly so the row still shows up rather than silently
            // dropping the update.
            if (!row) {
                row = {
                    sid,
                    label: sc.label || (sid || 'Baseline'),
                    status: 'pending',
                    completed: 0,
                    total: 0,
                    active: false,
                    error: null,
                };
                state.scenarios.set(sid, row);
            }
            row.label     = sc.label   || row.label;
            row.status    = sc.status  || row.status;
            row.error     = sc.error  ?? row.error;
            row.completed = wp[i]?.completed ?? row.completed;
            row.total     = wp[i]?.total     ?? row.total;
            row.active    = !!wp[i]?.active;
        }
        state.completedCount  = payload?.completed       ?? state.completedCount;
        state.totalCount      = payload?.total           ?? state.totalCount;
        state.activeWorkers   = payload?.activeWorkers   ?? state.activeWorkers;
        state.parallelWorkers = payload?.parallelWorkers ?? state.parallelWorkers;
    }

    // ── Poll-driven progress ──────────────────────────────────────────────
    // The WS push (batch:* events) is NOT reliably delivered in the pywebview
    // webview, so — like the single-run status readout — the grid is driven by
    // polling `scenarios_results_summary` while a batch is in flight. The WS
    // handlers above stay as a fast path when the push does work; both write
    // the same per-sid state, so they're idempotent.
    let pollTimer = null;

    function applySummary(summary) {
        const results = summary?.results || {};
        const batch = summary?.batch || {};
        for (const sid of Object.keys(results)) {
            const row = state.scenarios.get(sid);
            if (!row) continue;   // not part of THIS batch's seed — ignore stale
            const r = results[sid];
            row.label     = r.label || row.label;
            row.status    = r.status || row.status;
            row.error     = r.error ?? row.error;
            row.completed = Number(r.tick) || 0;
            row.total     = Number(r.target) || row.total;
            row.active    = !!r.in_progress;
        }
        state.totalCount     = Number(batch.total) || state.scenarios.size;
        state.completedCount = Number(batch.completed) || 0;
        state.activeWorkers  = [...state.scenarios.values()]
            .filter((s) => s.status === 'running').length;
        state.paused = !!batch.paused;
        batchRunning = !!batch.running;
    }

    function stopPoll() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function startPoll() {
        stopPoll();
        pollTimer = setInterval(async () => {
            try {
                const s = await window.pywebview?.api?.scenarios_results_summary?.();
                if (!s) return;
                applySummary(s);
                render();
                if (!s.batch?.running) {
                    state.finished = true;
                    batchRunning = false;
                    render();
                    stopPoll();
                }
            } catch { /* best-effort; WS handlers may still drive it */ }
        }, 300);
    }

    eventBus.on('ecoagent:batch:started', (payload) => {
        startedAt = Date.now();
        seedScenarios(payload?.scenarios || []);
        ensureWindow();
        startPoll();
        render();
    });

    eventBus.on('ecoagent:batch:progress', (payload) => {
        if (!win) ensureWindow();
        applyProgressPayload(payload);
        render();
    });

    eventBus.on('ecoagent:batch:scenario', (payload) => {
        const sid = payload?.id == null ? '' : String(payload.id);
        const row = state.scenarios.get(sid);
        if (row) {
            row.status = payload?.status || row.status;
            row.error  = payload?.error ?? row.error;
            if (payload?.status === 'complete' || payload?.status === 'failed') {
                row.active = false;
                if (typeof payload.tick === 'number') row.completed = payload.tick;
            }
        }
        render();
    });

    eventBus.on('ecoagent:batch:completed', (payload) => {
        state.finished = true;
        batchRunning = false;
        state.completedCount = payload?.completed ?? state.completedCount;
        state.totalCount     = payload?.total     ?? state.totalCount;
        stopPoll();
        render();
    });

    // Re-open the window after it was minimized (e.g. from the bottom-bar
    // batch indicator). Just restores/shows the singleton window.
    eventBus.on('ecoagent:batch:reopen', () => { ensureWindow(); });

    // Elapsed timer — repaints once per second so the user sees the
    // clock advance even between push events.
    setInterval(() => { if (startedAt && !state.finished && host) render(); }, 1000);

    function openForBatch(expectedScenarios) {
        ensureWindow();
        if (Array.isArray(expectedScenarios) && expectedScenarios.length) {
            startedAt = Date.now();
            seedScenarios(expectedScenarios);
        }
        startPoll();   // drive the grid by polling — see startPoll()
        render();
        return win;
    }

    _singleton = {
        open: ensureWindow,
        openForBatch,
        get window() { return win; },
    };
    return _singleton;
}

export function getBatchWorkersWindow() {
    return _singleton;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
