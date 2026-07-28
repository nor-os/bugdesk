/**
 * currency_manager.js — shared modal for currency add / rename /
 * delete.
 *
 * Uses the standard `.ea-modal*` chrome so it fits the rest of
 * EcoAgent visually (same overlay, header, body padding, close-X,
 * keyboard handling). Invoked from any currency dropdown via the
 * `Manage currencies…` sentinel.
 *
 * Country-3: there is no "domestic" currency anymore — per-sector
 * currency context resolves via Sector → Country → Country.currency.
 * The earlier "Set as domestic" affordance was removed accordingly.
 *
 * Returns once the user closes the modal; callers should re-fetch
 * `currencies_list` afterwards to pick up any changes.
 */

import { openForm, openConfirm } from './modal.js';
import { toastError } from './toast.js';


/** Open the manage-currencies modal. Resolves when the user closes
 *  it. Returns nothing — callers re-read state via the bridge. */
export async function openCurrencyManager() {
    const overlay = document.createElement('div');
    overlay.className = 'ea-modal__overlay';
    overlay.innerHTML = `
        <div class="ea-modal" role="dialog" aria-label="Manage currencies"
             style="min-width: 520px;">
            <header class="ea-modal__header">
                <h3>Manage currencies</h3>
                <button type="button" class="ea-modal__close" aria-label="Close">×</button>
            </header>
            <div class="ea-modal__body" style="padding-top: 8px;">
                <p style="color:#999; font-size:12px; margin:0 0 12px;">
                    Currencies are project-wide value units; each is
                    assigned to one or more countries (currency-union
                    case). Renaming cascades to every asset kind,
                    country, and bank-archetype reference.
                </p>
                <div data-role="list" class="ea-cm-list"></div>
            </div>
            <div class="ea-modal__actions" style="border-top: 1px solid #333; padding: 10px 18px; display: flex; gap: 8px;">
                <button class="ea-btn" data-action="add">+ Add currency</button>
                <span style="flex: 1;"></span>
                <button class="ea-btn ea-btn--primary" data-action="close">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const close = () => {
        try { overlay.remove(); } catch { /* ignore */ }
        document.removeEventListener('keydown', onKey);
        resolveDone();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    const render = async () => {
        const [ccys, sectors] = await Promise.all([
            window.pywebview?.api?.currencies_list?.() ?? [],
            window.pywebview?.api?.sectors_list?.() ?? [],
        ]);
        const sectorIds = new Set((sectors || []).map((s) => s.id));
        const listEl = overlay.querySelector('[data-role="list"]');
        if (!ccys.length) {
            listEl.innerHTML = `
                <p style="color:#777; font-style:italic; text-align:center; padding: 16px;">
                    No currencies yet — use <b>+ Add currency</b> above.
                </p>
            `;
            return;
        }
        listEl.innerHTML = ccys.map((c) => {
            const issuer = c.issuer_sector
                ? (sectorIds.has(c.issuer_sector) ? c.issuer_sector
                                                  : `${c.issuer_sector} (missing)`)
                : null;
            return `
                <div class="ea-cm-list__row" data-ccy="${c.id}">
                    <div class="ea-cm-list__id">${c.id}${c.symbol ? ` <small>${c.symbol}</small>` : ''}</div>
                    <div class="ea-cm-list__label">${c.label || ''}</div>
                    ${issuer ? `<div class="ea-cm-list__meta">issuer: ${issuer}</div>` : ''}
                    <div class="ea-cm-list__actions">
                        <button class="ea-btn ea-btn--small" data-action="edit">Edit</button>
                        <button class="ea-btn ea-btn--small" data-action="delete">Delete</button>
                    </div>
                </div>
            `;
        }).join('');
    };

    // Header X button — bare `.ea-modal__close` with no `data-action`,
    // so it was never matched by the data-action dispatcher below
    // (Escape / overlay-click / footer Close all worked, but the
    // header X didn't). Wire it directly.
    overlay.querySelector('.ea-modal__close')
        ?.addEventListener('click', close);

    overlay.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === 'close') return close();
        if (action === 'add')   { await _onAdd();   await render(); return; }
        const row = btn.closest('[data-ccy]');
        const id  = row?.dataset?.ccy;
        if (!id) return;
        if (action === 'edit')   { await _onEdit(id);   await render(); return; }
        if (action === 'delete') { await _onDelete(id); await render(); return; }
    });

    await render();
    return done;
}


// ---- per-action handlers (use the shared openForm/openConfirm) ----

async function _onAdd() {
    const sectors = await window.pywebview?.api?.sectors_list?.() ?? [];
    const sectorOpts = [{ value: '', label: '— none —' },
                        ...sectors.map((s) => ({ value: s.id, label: s.id }))];
    const data = await openForm({
        title: 'Add currency',
        fields: [
            { name: 'id', label: 'Id', type: 'text', required: true,
              placeholder: 'e.g. USD' },
            { name: 'label', label: 'Label', type: 'text',
              placeholder: 'US Dollar' },
            { name: 'symbol', label: 'Symbol', type: 'text', placeholder: '$' },
            { name: 'issuer_sector', label: 'Issuer sector', type: 'select',
              options: sectorOpts,
              hint: 'Optional legacy field; superseded by Country.central_bank.' },
        ],
        submitLabel: 'Add',
    });
    if (!data) return;
    const cid = String(data.id || '').trim();
    if (!cid) return;
    const res = await window.pywebview?.api?.currency_add?.(
        cid, String(data.label || '').trim() || cid,
        String(data.symbol || '').trim(),
        data.issuer_sector ? String(data.issuer_sector) : null,
    );
    if (res?.ok === false) toastError('Add currency failed', res.error);
}


async function _onEdit(id) {
    const ccys = await window.pywebview?.api?.currencies_list?.() ?? [];
    const c = ccys.find((x) => x.id === id);
    if (!c) return;
    const sectors = await window.pywebview?.api?.sectors_list?.() ?? [];
    const sectorOpts = [{ value: '', label: '— none —' },
                        ...sectors.map((s) => ({ value: s.id, label: s.id }))];
    const data = await openForm({
        title: `Edit currency "${id}"`,
        fields: [
            { name: 'new_id', label: 'Id', type: 'text', required: true,
              default: id,
              hint: 'Renaming cascades to every asset kind / sector / '
                  + 'bank archetype / country referencing this currency.' },
            { name: 'label', label: 'Label', type: 'text', default: c.label || '' },
            { name: 'symbol', label: 'Symbol', type: 'text', default: c.symbol || '' },
            { name: 'issuer_sector', label: 'Issuer sector', type: 'select',
              default: c.issuer_sector || '', options: sectorOpts },
        ],
        submitLabel: 'Save',
    });
    if (!data) return;
    const res = await window.pywebview?.api?.currency_update?.(
        id,
        String(data.new_id || '').trim() || id,
        String(data.label || ''),
        String(data.symbol || ''),
        String(data.issuer_sector || ''),
    );
    if (res?.ok === false) toastError('Edit currency failed', res.error);
}


async function _onDelete(id) {
    const ok = await openConfirm({
        title: 'Delete currency',
        message: `Delete "${id}"? Refused if any asset kind or country still uses it.`,
        confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    const res = await window.pywebview?.api?.currency_remove?.(id);
    if (res?.ok === false) toastError('Delete currency failed', res.error);
}
