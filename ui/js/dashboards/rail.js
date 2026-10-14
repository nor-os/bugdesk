/**
 * rail.js — the Navigator while Dashboards is in front (EPIC-0033).
 *
 * The left panel follows the top nav (pages.js `mountTicketNav`): bug filters
 * under Bugs, views and work packages under Backlog, and here the project's
 * dashboards, shared then personal. A row opens that dashboard in the primary
 * tile, the way a filter row opens the bug queue; "New dashboard" asks for a
 * name, saves an empty one and opens it. Everything else a dashboard offers
 * (tiles, rename, copy, share, delete) is on the page itself.
 */

import { saveShared, savePersonal } from './store.js';
import { newEntry, newId, readEntry } from './model.js';
import {
    SCOPES, askName, keyOf, lists, loadLibrary, notifyLibrary, onLibraryChanged, selectedKey,
} from './library.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const icon = (name) => `<span class="material-symbols-outlined">${esc(name)}</span>`;

export function mountDashboardsRail(host, ctx) {
    const open = (key) => ctx.wm?.openInPrimary?.('dashboards', { dashboard: key });
    let error = '';

    const section = (scope) => {
        const s = SCOPES[scope];
        const { entries, broken } = lists[scope];
        const rows = entries.map((e, i) => {
            const key = keyOf(scope, e, i);
            const name = e.name || e.id || `Entry ${i + 1}`;
            return `
            <div class="td-nav__item bd-dash-nav__item bd-dash-nav__item--${scope}${key === selectedKey() ? ' is-selected' : ''}${e.ok ? '' : ' is-broken'}"
                 data-dashboard="${esc(key)}" data-scope="${scope}" role="button" tabindex="0"
                 title="${esc(e.ok ? s.tip : `Cannot be read: ${e.reason}`)}">
                ${icon(e.ok ? s.icon : 'warning')}<span>${esc(name)}</span>
            </div>`;
        }).join('');
        return `
            <div class="td-nav__section">${s.heading}</div>
            ${broken ? `<div class="td-nav__item bd-dash-nav__banner">${icon('warning')}<span>${s.heading} dashboards cannot be read: ${esc(broken)}. Nothing is saved to them until ${esc(s.file)} is fixed.</span></div>` : ''}
            ${rows || (broken ? '' : `<div class="td-nav__item"><span class="td-dim">${esc(s.empty)}</span></div>`)}
            ${broken ? '' : `
            <div class="td-nav__item" data-new="${scope}" role="button" tabindex="0">
                ${icon('add')}<span class="td-dim">${scope === 'shared' ? 'New dashboard' : 'New personal dashboard'}</span>
            </div>`}`;
    };

    const render = () => {
        host.innerHTML = `
            <div class="td-nav bd-dash-nav">
                ${section('shared')}
                ${section('personal')}
                ${error ? `<div class="td-nav__item bd-dash-nav__banner">${icon('error')}<span>${esc(error)}</span></div>` : ''}
            </div>`;
    };

    async function create(scope) {
        const name = await askName(scope === 'shared' ? 'New dashboard' : 'New personal dashboard', scope);
        if (!name) return;
        const raw = newEntry(name, newId(scope === 'shared' ? 'd' : 'p')).raw;
        try { await (scope === 'shared' ? saveShared : savePersonal)(raw); }
        catch (err) { error = `Not saved: ${err.message}`; render(); return; }
        error = '';
        const entry = readEntry(raw);
        lists[scope].entries.push(entry);
        notifyLibrary();
        open(keyOf(scope, entry));
    }

    const activate = (target) => {
        const row = target.closest('[data-dashboard], [data-new]');
        if (!row || !host.contains(row)) return;
        if (row.dataset.new) create(row.dataset.new);
        else open(row.dataset.dashboard);
    };
    const onClick = (e) => activate(e.target);
    const onKey = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        activate(e.target);
    };
    host.addEventListener('click', onClick);
    host.addEventListener('keydown', onKey);

    render();
    const unsub = onLibraryChanged(render);
    loadLibrary().catch(() => { /* each list carries its own reason */ });

    return {
        destroy() {
            unsub();
            host.removeEventListener('click', onClick);
            host.removeEventListener('keydown', onKey);
            host.innerHTML = '';
        },
    };
}
