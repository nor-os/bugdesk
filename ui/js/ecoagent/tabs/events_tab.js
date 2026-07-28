/**
 * events_tab.js — editor for the project's scheduled events (events.json).
 *
 * An event fires at a given tick. Today the one action is `set_param`
 * (set a parameter on an archetype at that tick) — a small editable table:
 * Tick / Action / Archetype / Parameter / Value, with add + remove. Backed by
 * events_list / events_add / events_update / events_remove / events_actions.
 *
 * Factory contract: `(hostEl, id, ctx)` → `{ mount, destroy }`.
 */

import { esc } from './_util.js';
import { toastError } from '../ui/toast.js';

export function makeEventsTab(hostEl, _id, ctx) {
    const api = window.pywebview?.api;
    const eventBus = ctx?.eventBus;
    let events = [];
    let actions = [];

    const notify = () =>
        eventBus?.emit?.('ecoagent:project:changed', { source: 'events' });

    const load = async () => {
        try {
            const [evs, acts] = await Promise.all([
                api?.events_list?.() ?? [],
                api?.events_actions?.() ?? [],
            ]);
            events = Array.isArray(evs) ? evs : [];
            actions = Array.isArray(acts) ? acts : [];
        } catch { events = []; actions = []; }
        if (!actions.length) actions = [{ action: 'set_param', label: 'Set parameter' }];
    };

    const save = async (i, ev) => {
        try {
            const r = await api?.events_update?.(i, ev.tick, ev.action, ev.params);
            if (r?.ok === false) toastError('Save event', r.error || 'failed');
            else notify();
        } catch (e) { toastError('Save event', String(e?.message || e)); }
    };

    const render = () => {
        const opts = actions.map((a) =>
            `<option value="${esc(a.action)}">${esc(a.label || a.action)}</option>`).join('');
        hostEl.innerHTML = `
            <div class="ea-detail-header">
                <span class="ea-detail-header__title">Events</span>
                <span class="ea-detail-header__spacer"></span>
                <button type="button" class="ea-btn ea-btn--small" data-role="add">
                    <span class="material-symbols-outlined">add</span> Add event
                </button>
            </div>
            <div style="padding:8px 12px;font-size:12px;opacity:.7">
                Scheduled events fire at a given tick — e.g. set a parameter on an
                archetype mid-run. Edits save as you change a field.
            </div>
            <div data-role="rows" style="padding:0 12px 12px"></div>`;
        const rows = hostEl.querySelector('[data-role="rows"]');
        if (!events.length) {
            rows.innerHTML =
                '<div class="ea-table__empty">No scheduled events. Add one to '
                + 'fire a parameter change at a given tick.</div>';
        } else {
            rows.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
                <tr style="opacity:.6;text-align:left">
                    <th style="padding:4px 8px 4px 0">Tick</th>
                    <th style="padding:4px 8px 4px 0">Action</th>
                    <th style="padding:4px 8px 4px 0">Archetype</th>
                    <th style="padding:4px 8px 4px 0">Parameter</th>
                    <th style="padding:4px 8px 4px 0">Value</th><th></th></tr>
                ${events.map((e, i) => {
                    const p = e.params || {};
                    return `<tr data-i="${i}">
                        <td style="padding:2px 8px 2px 0"><input data-f="tick" type="number" value="${esc(e.tick ?? 0)}" style="width:70px"></td>
                        <td style="padding:2px 8px 2px 0"><select data-f="action">${opts}</select></td>
                        <td style="padding:2px 8px 2px 0"><input data-f="archetype" value="${esc(p.archetype || '')}"></td>
                        <td style="padding:2px 8px 2px 0"><input data-f="name" value="${esc(p.name || '')}"></td>
                        <td style="padding:2px 8px 2px 0"><input data-f="value" type="number" value="${esc(p.value ?? '')}" style="width:90px"></td>
                        <td><button type="button" data-role="rm" title="Remove event"
                                    class="ea-btn ea-btn--icon"><span class="material-symbols-outlined">delete</span></button></td>
                    </tr>`;
                }).join('')}
            </table>`;
            rows.querySelectorAll('select[data-f="action"]').forEach((sel, i) => {
                sel.value = events[i]?.action || 'set_param';
            });
        }
        hostEl.querySelector('[data-role="add"]')?.addEventListener('click', async () => {
            await api?.events_add?.(0, 'set_param', { archetype: '', name: '', value: 0 });
            await load(); render(); notify();
        });
        rows.querySelectorAll('tr[data-i]').forEach((tr) => {
            const i = Number(tr.dataset.i);
            const collect = () => {
                const g = (f) => tr.querySelector(`[data-f="${f}"]`)?.value;
                return {
                    tick: Number(g('tick')) || 0,
                    action: g('action') || 'set_param',
                    params: {
                        archetype: g('archetype') || '', name: g('name') || '',
                        value: Number(g('value')) || 0,
                    },
                };
            };
            tr.querySelectorAll('[data-f]').forEach((inp) =>
                inp.addEventListener('change', () => save(i, collect())));
            tr.querySelector('[data-role="rm"]')?.addEventListener('click', async () => {
                await api?.events_remove?.(i); await load(); render(); notify();
            });
        });
    };

    return {
        async mount() { await load(); render(); },
        destroy() { hostEl.innerHTML = ''; },
    };
}
