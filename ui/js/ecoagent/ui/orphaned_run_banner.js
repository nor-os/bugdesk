/**
 * orphaned_run_banner.js — surface runs that ended abnormally.
 *
 * When a live run crashes, the user closes the app mid-run, or the OS
 * kills it, the run-stream writer leaves
 * `<project>/.ecoagent/current.run/{manifest.json, runlog.ndjson}` on
 * disk with state ∈ {running, paused, stopped, error}. On project
 * open this banner surfaces it with three actions:
 *
 *   Resume    — start a new run from the latest checkpoint ≤ the
 *               manifest's last_tick. Disabled when no checkpoint is
 *               available (the bridge tells us via latest_checkpoint).
 *   Save as…  — promote current.run/ → runs/<label>/ so the streamed
 *               log + manifest survive as a labelled artifact.
 *   Discard   — wipe current.run/. Banner won't reopen on next start.
 *
 * Sits at the top-center of the viewport so it's visible regardless of
 * which tile/desktop is active. Coexists with the external-changes
 * banner on a slightly lower z-index — modals still trump both.
 */

import { openForm, openConfirm } from './modal.js';
import { toastError, toastInfo } from './toast.js';


export async function checkAndShowOrphanedRun({ api, eventBus } = {}) {
    if (!api?.orphaned_run_status) return { stop: () => {} };
    let status = null;
    try { status = await api.orphaned_run_status(); }
    catch { return { stop: () => {} }; }
    if (!status?.present) return { stop: () => {} };

    const banner = document.createElement('div');
    banner.className = 'ea-orphan-banner';
    const m = status.manifest || {};
    const stateLabel = String(m.state || 'unknown').toUpperCase();
    const lastTick   = Number(m.last_tick) || 0;
    const total      = Number(m.n_ticks)   || 0;
    const scen       = String(m.scenario_id || '');
    const ckAvail    = !!status.latest_checkpoint;
    const ckTick     = ckAvail
        ? (status.latest_checkpoint.match(/_t(\d+)\.pkl$/)?.[1] || '?')
        : null;

    banner.innerHTML = `
        <span class="material-symbols-outlined ea-orphan-banner__icon">restart_alt</span>
        <div class="ea-orphan-banner__body">
            <div class="ea-orphan-banner__title">
                <strong>${_esc(stateLabel)}</strong> run · tick ${lastTick}/${total}
                ${scen ? `· scenario <code>${_esc(scen)}</code>` : ''}
            </div>
            <div class="ea-orphan-banner__meta">
                ${ckAvail
                    ? `Latest checkpoint at tick ${_esc(ckTick)} — Resume will start from there.`
                    : 'No checkpoint available — Resume disabled; use Save&nbsp;as to preserve the log.'}
            </div>
        </div>
        <div class="ea-orphan-banner__actions">
            <button type="button" class="ea-orphan-banner__btn"
                    data-action="resume" ${ckAvail ? '' : 'disabled'}>
                Resume
            </button>
            <button type="button" class="ea-orphan-banner__btn"
                    data-action="save">Save as…</button>
            <button type="button" class="ea-orphan-banner__btn ea-orphan-banner__btn--danger"
                    data-action="discard">Discard</button>
            <button type="button" class="ea-orphan-banner__close"
                    data-action="dismiss" title="Dismiss for this session">
                <span class="material-symbols-outlined">close</span>
            </button>
        </div>
    `;
    document.body.appendChild(banner);

    const close = () => { try { banner.remove(); } catch {} };

    banner.querySelector('[data-action="dismiss"]')
        ?.addEventListener('click', close);

    banner.querySelector('[data-action="resume"]')
        ?.addEventListener('click', async () => {
            if (!ckAvail) return;
            const remaining = Math.max(total - lastTick, 200);
            try {
                const r = await api.orphaned_run_resume?.({ ticks: remaining });
                if (r?.ok === false) {
                    toastError?.('Resume failed', r.error || 'unknown');
                    return;
                }
                toastInfo?.('Resuming', `from tick ${ckTick}`);
                eventBus?.emit?.('ecoagent:run:resumed', { from_tick: ckTick });
                close();
            } catch (err) {
                toastError?.('Resume failed', err?.message || String(err));
            }
        });

    banner.querySelector('[data-action="save"]')
        ?.addEventListener('click', async () => {
            const data = await openForm({
                title: 'Save run',
                submitLabel: 'Save',
                fields: [
                    { name: 'label', label: 'Name', type: 'text', required: true,
                      placeholder: `e.g. ${stateLabel.toLowerCase()}-${lastTick}t`,
                      hint: 'Lowercased + safe-charactered into a folder name under runs/.' },
                ],
            });
            if (!data?.label) return;
            try {
                const r = await api.orphaned_run_save_as?.({ label: data.label });
                if (r?.ok === false) {
                    toastError?.('Save run', r.error || 'failed');
                    return;
                }
                toastInfo?.('Saved', r.path || '');
                eventBus?.emit?.('ecoagent:saved_runs:changed', {});
                close();
            } catch (err) {
                toastError?.('Save run', err?.message || String(err));
            }
        });

    banner.querySelector('[data-action="discard"]')
        ?.addEventListener('click', async () => {
            const ok = await openConfirm({
                title: 'Discard run',
                message: `Throw away the ${stateLabel.toLowerCase()} run `
                       + `at tick ${lastTick}? Its manifest + log will be deleted.`,
                confirmLabel: 'Discard', danger: true,
            });
            if (!ok) return;
            try {
                await api.orphaned_run_discard?.();
                close();
            } catch (err) {
                toastError?.('Discard', err?.message || String(err));
            }
        });

    return { stop: close };
}

function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
