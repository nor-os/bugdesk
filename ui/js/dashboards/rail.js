/**
 * rail.js — a section's dashboards, at the top of its rail (EPIC-0033, STORY-0046).
 *
 * There is no Dashboards chip: a dashboard belongs to a section (its `section`
 * key, model.js), and the left panel of Bugs, Backlog and Tracker
 * (pages.js `mountTicketNav`) mounts this group above its own filters, listing
 * the project dashboards and then the personal ones of that section, plus the
 * ones listed in all sections. A row opens that dashboard in the primary tile,
 * under the same chip, the way a filter row opens the queue; "New dashboard"
 * asks for a name, saves an empty one listed in this section and opens it.
 * A row's hover buttons and its right-click menu rename it, move it to another
 * section and delete it; the page (page.js) has the rest (tiles, copy, share).
 */

import { openConfirm, showContextMenu } from '@flexdesk/widgets';
import { saveShared, savePersonal, deleteShared, deletePersonal } from './store.js';
import { SECTION_LABEL, listedIn, newEntry, newId, readEntry, sectionOf, withSection } from './model.js';
import {
    SCOPES, askDetails, askName, entryFor, keyOf, lists, loadLibrary, notifyLibrary, onLibraryChanged, selectedKey,
    trackWrite,
} from './library.js';
import { DASHBOARD_KIND, DASHBOARD_SECTIONS } from '../tiling/kind_taxonomy.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const icon = (name) => `<span class="material-symbols-outlined">${esc(name)}</span>`;
const navAction = (act, glyph, label, danger = false) =>
    `<button type="button" class="td-nav__action${danger ? ' td-nav__action--danger' : ''}"
             data-act="${act}" title="${esc(label)}" aria-label="${esc(label)}">${icon(glyph)}</button>`;

const STORE = {
    shared: { save: saveShared, remove: deleteShared },
    personal: { save: savePersonal, remove: deletePersonal },
};

/**
 * Mount the Dashboards group of `section`'s rail ('bugs' | 'backlog' |
 * 'tracker'; the landing section's when not given) into `host`.
 */
export function mountDashboardsRail(host, ctx, { section = DASHBOARD_SECTIONS[0] || 'bugs', eventBus = null } = {}) {
    const kind = DASHBOARD_KIND[section] || 'dashboards';
    /**
     * The key of the dashboard this section's page shows in the main area, or
     * null. The rail is on every page of the section, so a row is marked only
     * while the main area is this section's dashboard page: not while it shows
     * the queue, and never in another section's rail. Without a window manager
     * to ask (tests), the page's own mark is the answer.
     */
    const openKey = () => {
        const tree = (ctx.wm || window.__twm?.wm)?.desktops?.active?.()?.tree;
        if (tree) {
            const id = tree.primaryLeafId?.();
            if ((id ? tree.get(id)?.content?.kind : null) !== kind) return null;
        }
        return selectedKey(kind);
    };
    let marked = null;
    // `label` names the tab (the WM titles a tab by it), so the tile reads the
    // dashboard's name rather than the kind id when its page is restored.
    const open = (key) => {
        const name = entryFor(key)?.entry.name;
        ctx.wm?.openInPrimary?.(kind, { dashboard: key, ...(name ? { label: name } : {}) });
    };
    let error = '';

    /** `[entry, its index in the whole list]` for the entries this section lists. */
    const here = (scope) => lists[scope].entries.map((e, i) => [e, i]).filter(([e]) => listedIn(e, section, DASHBOARD_SECTIONS));

    const group = (scope) => {
        const s = SCOPES[scope];
        const { broken } = lists[scope];
        const rows = here(scope).map(([e, i]) => {
            const key = keyOf(scope, e, i);
            const name = e.name || e.id || `Entry ${i + 1}`;
            const where = sectionOf(e);
            const everywhere = where === 'all' && DASHBOARD_SECTIONS.length > 1;
            const stray = !['all', 'tracker'].includes(where) && !DASHBOARD_SECTIONS.includes(where);
            const tip = e.ok
                ? `${s.tip}${everywhere ? '. Listed in all sections' : ''}${stray ? `. Listed in ${SECTION_LABEL[where]}, which this project does not have, so it is shown in every section` : ''}`
                : `Cannot be read: ${e.reason}`;
            return `
            <div class="td-nav__item bd-dash-nav__item bd-dash-nav__item--${scope}${key === marked ? ' is-selected' : ''}${e.ok ? '' : ' is-broken'}"
                 data-dashboard="${esc(key)}" data-scope="${scope}" role="button" tabindex="0"
                 title="${esc(tip)}">
                ${icon(e.ok ? s.icon : 'warning')}<span>${esc(name)}</span>
                ${broken || !e.id ? '' : `<span class="td-nav__actions">
                    ${e.ok ? navAction('rename', 'edit', `Rename or move ${name}`) : ''}
                    ${navAction('delete', 'delete', `Delete ${name}`, true)}
                </span>`}
            </div>`;
        }).join('');
        return `
            <div class="td-nav__section">${s.heading} dashboards</div>
            ${broken ? `<div class="td-nav__item bd-dash-nav__banner">${icon('warning')}<span>${s.heading} dashboards cannot be read: ${esc(broken)}. Nothing is saved to them until ${esc(s.file)} is fixed.</span></div>` : ''}
            ${rows || (broken ? '' : `<div class="td-nav__item" title="${esc(s.emptyTip)}"><span class="td-dim">${esc(s.empty)}</span></div>`)}
            ${broken ? '' : `
            <div class="td-nav__item" data-new="${scope}" role="button" tabindex="0">
                ${icon('add')}<span class="td-dim">${scope === 'shared' ? 'New dashboard' : 'New personal dashboard'}</span>
            </div>`}`;
    };

    const render = () => {
        marked = openKey();
        host.innerHTML = `
            <div class="td-nav bd-dash-nav" data-section="${esc(section)}">
                ${group('shared')}
                ${group('personal')}
                ${error ? `<div class="td-nav__item bd-dash-nav__banner">${icon('error')}<span>${esc(error)}</span></div>` : ''}
            </div>`;
    };
    const fail = (what, err) => { error = `${what}: ${err.message}`; render(); };

    async function create(scope) {
        const name = await askName(scope === 'shared' ? 'New dashboard' : 'New personal dashboard', scope, {
            hint: DASHBOARD_SECTIONS.length > 1 ? `Listed under ${SECTION_LABEL[section]}. Rename it to list it somewhere else.` : undefined,
        });
        if (!name) return;
        const raw = newEntry(name, newId(scope === 'shared' ? 'd' : 'p'), section).raw;
        try { await trackWrite(STORE[scope].save(raw)); }
        catch (err) { fail('Not saved', err); return; }
        error = '';
        const entry = readEntry(raw);
        lists[scope].entries.push(entry);
        notifyLibrary();
        open(keyOf(scope, entry));
    }

    /** The row's entry, looked up again: the lists may have been re-read since it was drawn. */
    const entryAt = (scope, key) => lists[scope].entries.find((e, i) => keyOf(scope, e, i) === key) || null;

    /** Rename it and choose where it is listed. The page showing it follows (page.js). */
    async function rename(scope, key) {
        const entry = entryAt(scope, key);
        if (!entry?.ok) return;
        const r = await askDetails('Rename dashboard', scope, {
            name: entry.name, section: sectionOf(entry), sections: DASHBOARD_SECTIONS, exceptId: entry.id,
        });
        const now = entryAt(scope, key);
        if (!r || !now?.ok) return;
        if (r.name === now.name && r.section === sectionOf(now)) return;
        const raw = { ...withSection(now.raw, r.section), name: r.name };
        try { await trackWrite(STORE[scope].save(raw)); }
        catch (err) { fail('Not saved', err); return; }
        error = '';
        const saved = readEntry(raw);
        lists[scope].entries = lists[scope].entries.map((e) => (e === now ? saved : e));
        notifyLibrary();
    }

    async function remove(scope, key) {
        const entry = entryAt(scope, key);
        if (!entry?.id) return;
        const message = scope === 'shared'
            ? `<p>Delete <b>${esc(entry.name || entry.id)}</b> for everyone on this project?</p><p>The change is in project.json until you commit it.</p>`
            : `<p>Delete your personal dashboard <b>${esc(entry.name || entry.id)}</b>?</p>`;
        const ok = await openConfirm({ title: 'Delete dashboard', message, confirmLabel: 'Delete', danger: true, icon: 'delete' });
        if (!ok) return;
        try { await trackWrite(STORE[scope].remove(entry.id)); }
        catch (err) { fail('Not deleted', err); return; }
        error = '';
        lists[scope].entries = lists[scope].entries.filter((e) => e !== entry && !(e.ok && e.id === entry.id));
        notifyLibrary();
    }

    const run = (act, row) => {
        const { scope, dashboard: key } = row.dataset;
        if (act === 'open') open(key);
        else if (act === 'rename') rename(scope, key);
        else if (act === 'delete') remove(scope, key);
    };

    const activate = (target) => {
        const row = target.closest('[data-dashboard], [data-new]');
        if (!row || !host.contains(row)) return;
        if (row.dataset.new) { create(row.dataset.new); return; }
        const btn = target.closest('.td-nav__action');
        run(btn && row.contains(btn) ? btn.dataset.act : 'open', row);
    };
    const onClick = (e) => activate(e.target);
    const onKey = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target.closest('.td-nav__action')) return;      // a native button: its click is enough
        e.preventDefault();
        activate(e.target);
    };
    const onMenu = (e) => {
        const row = e.target.closest('[data-dashboard]');
        if (!row || !host.contains(row)) return;
        e.preventDefault();
        const entry = entryAt(row.dataset.scope, row.dataset.dashboard);
        const editable = entry?.id && !lists[row.dataset.scope].broken;
        const items = [
            { label: 'Open', icon: 'open_in_new', action: 'open' },
            ...(editable && entry.ok ? [{ label: 'Rename or move…', icon: 'edit', action: 'rename' }] : []),
            ...(editable ? [{ separator: true }, { label: 'Delete dashboard', icon: 'delete', action: 'delete', danger: true }] : []),
        ];
        showContextMenu(e.clientX, e.clientY, items, (action) => run(action, row));
    };
    host.addEventListener('click', onClick);
    host.addEventListener('keydown', onKey);
    host.addEventListener('contextmenu', onMenu);

    render();
    const unsub = onLibraryChanged(render);
    // The main area moved (the queue opened, a tab switched): repaint only when
    // that changes the mark, so a burst of wm:changed leaves hover and focus be.
    const wmSub = eventBus?.on?.('wm:changed', () => { if (openKey() !== marked) render(); });
    loadLibrary().catch(() => { /* each list carries its own reason */ });

    return {
        section,
        destroy() {
            unsub();
            try { wmSub?.dispose?.(); } catch { /* already gone */ }
            host.removeEventListener('click', onClick);
            host.removeEventListener('keydown', onKey);
            host.removeEventListener('contextmenu', onMenu);
            host.innerHTML = '';
        },
    };
}
