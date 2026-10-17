/**
 * page.js — the `dashboards` content kind (EPIC-0033, STORY-0034).
 *
 * The open dashboard as a FlexDesk `TileGrid` of chart and KPI tiles, which can
 * be added, removed, dragged, resized and configured. The project's dashboards
 * are listed in the Navigator (rail.js), which opens one here; both share the
 * lists in library.js. The grid, the tiles, the charts and the Plotly loader
 * are all FlexDesk's (`@flexdesk/tiles`, `@flexdesk/charts`); this file is the
 * page and the saving.
 *
 * NOTHING HEAVY AT BOOT. `@flexdesk/tiles` and `@flexdesk/charts` are imported
 * on the first mount of this page, never statically, and Plotly itself is
 * fetched by FlexDesk's `ensurePlotly` when the first chart draws — from the
 * vendored copy `setPlotlySource` points it at. Opening BugDesk without opening
 * a dashboard loads none of it.
 *
 * SAVING. A change to the grid is saved 600 ms after it settles, one dashboard
 * per request (see store.js), and only if what would be written differs from
 * what was read: building the grid is not a change, so opening a dashboard never
 * writes project.json. A save still pending when the page goes away (a tab
 * switch unmounts it) is written then rather than lost.
 *
 * Which dashboard is open is a prop of the tab (`props.dashboard`: a shared
 * one's id, or `personal:<id>`), so the window manager's saved layout reopens
 * it after a reload.
 *
 * ONE KIND PER SECTION (STORY-0046). There is no Dashboards chip; a dashboard
 * opens from its section's rail, under that section's chip, as `dashboards`
 * (Bugs), `backlog-dashboard` or `tracker-dashboard` (see DASHBOARD_KIND in
 * tiling/kind_taxonomy.js). They are all this page; the kind only says which
 * section's dashboards it falls back to when the open one is gone. A rename or
 * a delete made in the rail reaches the open page through the library.
 *
 * PERSONAL DASHBOARDS (STORY-0035) are listed under the shared ones in the
 * Navigator, marked with their own heading and icon, and here with a badge, and stored per profile in a
 * git-ignored file (store.js). A shared one can be copied to a personal one;
 * a personal one can be shared, which moves it into project.json under a new
 * id and a name no shared dashboard has, so it never replaces one.
 *
 * WHAT A TILE SHOWS (STORY-0036) is its `config.binding`, set in its settings
 * dialog (tile_editor.js) and turned into the tile's data by resolve.js over
 * the page's own stores (sources.js). Every tile is resolved again when its
 * store changes (`bugs:changed` / `backlog:changed`, which follow an edit here
 * and a change on disk alike). A click on a bar or a slice opens the records
 * behind it in the Bugs or Backlog list.
 */

import { makeLoadingOverlay, mountTileBreadcrumb } from '@flexdesk/wm';
import { openConfirm } from '@flexdesk/widgets';
import { loadShared, saveShared, deleteShared, savePersonal, deletePersonal } from './store.js';
import { freeName, newId, readEntry, sectionOf, toEntry, withSection } from './model.js';
import {
    SCOPES, askDetails, askName, entryFor, firstKey, keyOf, lists, loadLibrary, notifyLibrary,
    onLibraryChanged, readable, selectedKey, setSelectedKey, trackWrite,
} from './library.js';
import { DASHBOARD_KIND, DASHBOARD_SECTIONS, dashboardSectionOf, taxonomy } from '../tiling/kind_taxonomy.js';
import { drillExpr, resolveTile } from './resolve.js';
import { openTileSettings } from './tile_editor.js';

export const SAVE_DELAY_MS = 600;
export const PLOTLY_URL = new URL('../../vendor/plotly/plotly-2.35.2.min.js', import.meta.url).href;

let _libs = null;
/** FlexDesk's tiles and charts, imported once, on first use. */
export function loadDashboardLibs() {
    _libs ??= (async () => {
        const [tiles, charts, sources] = await Promise.all([
            import('@flexdesk/tiles'), import('@flexdesk/charts'), import('./sources.js')]);
        charts.setPlotlySource(PLOTLY_URL);
        tiles.registerChartTiles();
        await sources.loadTracker();     // tracker records (STORY-0038); nothing when it is off
        return { tiles, charts, sources };
    })().catch((err) => { _libs = null; throw err; });
    return _libs;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function button(label, icon, onClick, { title = '', primary = false } = {}) {
    const b = el('button', `twm-btn${primary ? ' twm-btn--primary' : ''} bd-dash__btn`);
    b.type = 'button';
    if (icon) b.append(el('span', 'material-symbols-outlined', icon));
    b.append(el('span', null, label));
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
}

/** The page, under every dashboards kind this page's taxonomy has. */
export function createDashboardsContent({ eventBus } = {}) {
    const kinds = [...new Set(Object.values(DASHBOARD_KIND))].filter((k) => taxonomy.meta(k));
    return Object.fromEntries(kinds.map((kind) =>
        [kind, (host, props, ctx) => mountDashboards(host, props || {}, ctx || {}, eventBus, kind)]));
}

function mountDashboards(host, props, ctx, eventBus, kind = 'dashboards') {
    const section = dashboardSectionOf(kind);
    host.classList.add('twm-page-shell');
    host.innerHTML = '';
    const crumbSlot = el('div', 'twm-page-shell__breadcrumb');
    const contentSlot = el('div', 'twm-page-shell__content');
    host.append(crumbSlot, contentSlot);
    let crumb = null;
    try {
        crumb = mountTileBreadcrumb(kind, props, { ...ctx, eventBus });
        crumbSlot.appendChild(crumb.el);
    } catch { /* no breadcrumb is not a broken page */ }

    const main = el('section', 'bd-dash__main');
    const page = el('div', 'bd-dash');
    page.append(main);
    contentSlot.append(page);

    const store = {
        shared: { save: saveShared, remove: deleteShared },
        personal: { save: savePersonal, remove: deletePersonal },
    };
    let selectedId = props.dashboard || null;
    let current = null;          // the readable entry the grid is showing
    let currentScope = null;     // 'shared' | 'personal', where `current` is stored
    let grid = null;
    let libs = null;
    let lastJson = null;         // what was last read or written for `current`
    let saveTimer = null;
    let building = false;        // true while the grid is being filled from storage
    let statusEl = null;
    let seq = 0;
    let disposed = false;

    const setStatus = (text, error = false) => {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.toggle('bd-dash__status--error', error);
    };

    const defaultsFor = (type) => {
        const Tile = libs?.tiles.getWidget(type);
        try { return Tile?.prototype.getDefaultConfig?.call({}) || {}; } catch { return {}; }
    };

    /* ── saving ─────────────────────────────────────────────────── */

    function scheduleSave() {
        if (building || !current) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { saveTimer = null; flush(); }, SAVE_DELAY_MS);
    }

    /** Write `current` as the grid now has it, if that differs from what is stored. */
    function flush() {
        clearTimeout(saveTimer);
        saveTimer = null;
        if (!current || !grid) return Promise.resolve();
        const raw = toEntry(current, grid.getLayout(), defaultsFor);
        return write(raw, currentScope);
    }

    function write(raw, scope) {
        const json = JSON.stringify(raw);
        if (json === lastJson) return Promise.resolve();
        // Deleted meanwhile (from the rail): saving would put it back.
        if (!lists[scope].entries.some((e) => e.ok && e.id === raw.id)) return Promise.resolve();
        const prev = lastJson;
        lastJson = json;
        const saved = readEntry(raw);
        if (current && current.id === saved.id && currentScope === scope) current = saved;
        lists[scope].entries = lists[scope].entries.map((e) => (e.ok && e.id === saved.id ? saved : e));
        notifyLibrary();
        setStatus('Saving…');
        return trackWrite(store[scope].save(raw)).then(
            () => { if (!disposed) setStatus('Saved'); },
            (err) => {
                if (lastJson === json) lastJson = prev;
                if (!disposed) setStatus(`Not saved: ${err.message}`, true);
                else console.error('[dashboards] a pending save failed', err);
            });
    }

    /* ── the chosen dashboard ───────────────────────────────────── */

    async function select(key, { remember = false } = {}) {
        if (current) await flush();
        disposeGrid();
        selectedId = key;
        if (remember) {
            try { ctx.wm?.updateActiveTabProps?.(ctx.leafId, { dashboard: key }); } catch { /* best effort */ }
        }
        setSelectedKey(key, kind);
        await renderMain();
    }

    function disposeGrid() {
        try { grid?.dispose(); } catch { /* already gone */ }
        grid = null;
        current = null;
        currentScope = null;
        lastJson = null;
    }

    /** The pane header reads the open dashboard's name, not the kind's label. */
    const nameTile = (name) => { try { ctx.setTitle?.(name || null); } catch { /* best effort */ } };

    async function renderMain() {
        const mine = ++seq;
        main.innerHTML = '';
        statusEl = null;
        const found = entryFor(selectedId);
        if (!found) {
            nameTile(null);
            main.append(el('div', 'bd-dash__empty', firstKey(section)
                ? 'Choose a dashboard under Dashboards in the left rail.'
                : 'No dashboards here yet. Create one with New dashboard at the top of the left rail; it is saved in the project config and shared with everyone on the repo. A personal dashboard is only yours.'));
            return;
        }
        const { scope, entry } = found;
        const where = SCOPES[scope];
        nameTile(entry.name || entry.id);
        if (!entry.ok) {
            const panel = el('div', 'bd-dash__broken');
            panel.append(el('h3', null, 'This dashboard could not be read'));
            panel.append(el('p', null, `Reason: ${entry.reason}.`));
            panel.append(el('p', 'bd-dash__dim', `It is kept in ${where.file} exactly as it is. Fix it there, or delete it.`));
            if (entry.id) panel.append(button('Delete', 'delete', () => remove(entry, scope)));
            main.append(panel);
            return;
        }

        const head = el('div', 'bd-dash__head');
        head.append(el('h2', 'bd-dash__title', entry.name));
        const badge = el('span', `bd-dash__scope bd-dash__scope--${scope}`);
        badge.append(el('span', 'material-symbols-outlined', where.icon), el('span', null, where.heading));
        badge.title = where.tip;
        head.append(badge);
        statusEl = el('span', 'bd-dash__status');
        const actions = el('div', 'bd-dash__actions');
        const disabled = !!lists[scope].broken;
        const buttons = [
            ['Add chart', 'insert_chart', () => addTile('flexdesk.chart'), 'add-chart', disabled],
            ['Add KPI', 'speed', () => addTile('flexdesk.kpi'), 'add-kpi', disabled],
            ['Rename', 'edit', () => rename(), 'rename', disabled],
            scope === 'shared'
                ? ['Copy to personal', 'content_copy', () => copyToPersonal(), 'copy-personal', !!lists.personal.broken]
                : ['Share', 'group_add', () => share(), 'share', disabled || !!lists.shared.broken],
            ['Delete', 'delete', () => remove(entry, scope), 'delete', disabled],
        ];
        for (const [label, icon, fn, action, off] of buttons) {
            const b = button(label, icon, fn);
            b.dataset.action = action;
            b.disabled = off;
            actions.append(b);
        }
        head.append(statusEl, actions);
        const body = el('div', 'bd-dash__grid');
        main.append(head);
        if (entry.keptTiles.length) {
            const n = entry.keptTiles.length;
            main.append(el('div', 'bd-dash__banner', `${n} tile${n === 1 ? '' : 's'} could not be read and ${n === 1 ? 'is' : 'are'} kept as ${n === 1 ? 'it is' : 'they are'} in ${where.file}.`));
        }
        main.append(body);

        const hide = makeLoadingOverlay(body);
        try { libs = await loadDashboardLibs(); }
        catch (err) {
            hide();
            if (mine === seq) body.append(el('div', 'bd-dash__banner', `The dashboard tiles could not be loaded: ${err.message}`));
            return;
        }
        hide();
        if (disposed || mine !== seq) return;
        // The status-history cache is only invalidated while a dashboard is
        // mounted; a store may have changed while none was, so start fresh.
        libs.sources.invalidateHistory();

        current = entry;
        currentScope = scope;
        lastJson = JSON.stringify(entry.raw);
        grid = new libs.tiles.TileGrid({
            container: body,
            host: ctx.host,      // the desktop app's native Save dialog for a tile's PNG (STORY-0026)
            showToolbar: false,
            readonly: disabled,
            // The config modal is ours; a tile's toast ("Chart saved to …") goes to the app's.
            eventBus: { emit: (name, payload) => {
                if (name === 'grid:config-modal-show') editTile(payload);
                else if (name === 'toast:show') eventBus?.emit?.(name, payload);
            } },
            onLayoutChange: () => scheduleSave(),
        });
        grid.gridElement.addEventListener('tile:remove-request', (e) => removeTile(e.detail?.tileId));
        building = true;
        try { grid.setLayout(JSON.parse(JSON.stringify(entry.tiles))); }
        finally { building = false; }
        grid.tiles.forEach((tile) => wireTile(tile));
        refreshTiles();
    }

    /* ── what the tiles show ────────────────────────────────────── */

    const tileSeq = new Map();   // tile id → number of its latest resolve
    const kindOf = (id) => (grid?.layout.find((l) => l.id === id)?.type === 'flexdesk.kpi' ? 'kpi' : 'chart');

    /** Resolve the tiles' bindings again (all, or `ids`) and hand each its data. */
    async function refreshTiles(ids = null) {
        const g = grid;
        if (!g || !libs) return;
        await Promise.all([...g.tiles].filter(([id]) => !ids || ids.includes(id)).map(async ([id, tile]) => {
            const mine = (tileSeq.get(id) || 0) + 1;
            tileSeq.set(id, mine);
            const binding = tile.config?.binding;
            let r;
            try {
                r = await resolveTile(binding?.source ? libs.sources.getSource(binding.source) : null, binding, { kind: kindOf(id) });
            } catch (err) { r = { error: err?.message || String(err) }; }
            if (g !== grid || tile._disposed || tileSeq.get(id) !== mine) return;
            if (r.data) { tile.setData(r.data); return; }
            tile.data = null;
            if (r.error) tile.showError(`This tile's data could not be read: ${r.error}`);
            else tile.showEmpty(r.empty);
        }));
    }

    let refreshTimer = null;
    /** A store changed: redraw the tiles once things settle. */
    const storeChanged = () => {
        libs?.sources.invalidateHistory();
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => { refreshTimer = null; refreshTiles(); }, 100);
    };
    // `tracker/backlog:changed` is the tracker's copy on a project page (STORY-0038).
    const subs = ['bugs:changed', 'backlog:changed', 'tracker/backlog:changed'].map((name) => eventBus?.on?.(name, storeChanged));

    /** A click on a bar or a slice opens the records behind it in the list view. */
    function wireTile(tile) {
        tile.onPointClick = ({ customdata }) => {
            const binding = tile.config?.binding;
            const src = binding?.source ? libs?.sources.getSource(binding.source) : null;
            const drill = src && drillExpr(src, binding, customdata, tile.config?.title);
            if (!drill) return;
            ctx.wm?.openInPrimary?.(src.listKind, src.listProps(drill.expr, drill.label));
        };
    }

    /* ── tiles ──────────────────────────────────────────────────── */

    function addTile(type) {
        if (!grid || !libs) return;
        const size = libs.tiles.getWidget(type)?.DEFAULT_SIZE || { w: 4, h: 3 };
        const pos = grid.findNextPosition(size.w, size.h);
        const id = newId('t');
        const tile = grid.addTile(type, { x: pos.x, y: pos.y, w: size.w, h: size.h }, {}, id);
        if (tile) { wireTile(tile); refreshTiles([id]); }
    }

    async function removeTile(tileId) {
        if (!grid || !tileId) return;
        const ok = await openConfirm({
            title: 'Remove tile', message: '<p>Remove this tile from the dashboard?</p>',
            confirmLabel: 'Remove', danger: true, icon: 'delete',
        });
        if (ok && grid) grid.removeTile(tileId);
    }

    async function editTile({ tileId, config, schema, onSave }) {
        const sources = libs ? libs.sources.availableSources().map((s) => libs.sources.getSource(s.id)).filter(Boolean) : [];
        const next = await openTileSettings({ kind: kindOf(tileId), config, schema, sources });
        if (!next || disposed) return;
        onSave(next);
        refreshTiles([tileId]);
    }

    /* ── dashboards ─────────────────────────────────────────────── */

    /** Store a new raw entry in `scope` and open it. */
    async function add(scope, raw) {
        await trackWrite(store[scope].save(raw));
        const entry = readEntry(raw);
        lists[scope].entries.push(entry);
        notifyLibrary();
        await select(keyOf(scope, entry), { remember: true });
    }

    async function rename() {
        if (!current) return;
        const r = await askDetails('Rename dashboard', currentScope, {
            name: current.name, section: sectionOf(current), sections: DASHBOARD_SECTIONS, exceptId: current.id,
        });
        if (!r || disposed || !current || (r.name === current.name && r.section === sectionOf(current))) return;
        current = { ...current, name: r.name, raw: withSection(current.raw, r.section) };
        await flush();
        main.querySelector('.bd-dash__title').textContent = r.name;
        nameTile(r.name);
    }

    /**
     * The library changed under the open dashboard: the rail renamed, moved or
     * deleted it, or a re-read brought a new copy. A copy this page wrote is
     * `current` itself and changes nothing here.
     */
    function followLibrary() {
        if (!current || disposed) return;
        const found = entryFor(keyOf(currentScope, current));
        if (found?.entry === current) return;
        if (!found || !found.entry.ok) {
            clearTimeout(saveTimer);
            saveTimer = null;
            disposeGrid();
            // Gone: the section's first. Unreadable now: say so, where it is.
            select(found ? selectedId : firstKey(section), { remember: !found });
            return;
        }
        // Keep the grid, and whatever on it is not saved yet: the next save
        // writes it over the stored entry, under its new name and keys.
        current = found.entry;
        lastJson = JSON.stringify(found.entry.raw);
        const title = main.querySelector('.bd-dash__title');
        if (title) title.textContent = current.name;
        nameTile(current.name);
    }
    const unfollow = onLibraryChanged(followLibrary);

    /** A copy of the open shared dashboard, as a new personal one. */
    async function copyToPersonal() {
        if (!current || currentScope !== 'shared') return;
        await flush();
        const raw = { ...JSON.parse(JSON.stringify(current.raw)), id: newId('p'),
            name: freeName(current.name, readable('personal')) };
        try { await add('personal', raw); }
        catch (err) { setStatus(`Not copied: ${err.message}`, true); }
    }

    /**
     * Move the open personal dashboard into the shared ones. It gets a new id, so
     * it can never replace a shared dashboard, and a name no shared one has: the
     * shared list is read again first, and a taken name is asked for again.
     */
    async function share() {
        if (!current || currentScope !== 'personal') return;
        await flush();
        const mine = current;
        try {
            Object.assign(lists.shared, await loadShared());
            notifyLibrary();
        } catch (err) { setStatus(`Not shared: ${err.message}`, true); return; }
        if (lists.shared.broken) { setStatus(`Not shared: shared dashboards cannot be read (${lists.shared.broken})`, true); return; }
        const name = await askName('Share dashboard', 'shared', {
            name: mine.name, submitLabel: 'Share',
            hint: 'It moves to the shared dashboards in project.json, for everyone on the repo once committed, and is no longer personal.',
        });
        if (!name || disposed) return;
        const raw = { ...JSON.parse(JSON.stringify(mine.raw)), id: newId('d'), name };
        try { await store.shared.save(raw); }
        catch (err) { setStatus(`Not shared: ${err.message}`, true); return; }
        // It is shared now: drop the personal grid, or select() below would flush
        // an unsaved change back into the personal file after it is removed.
        disposeGrid();
        let kept = null;
        try { await deletePersonal(mine.id); } catch (err) { kept = err; }
        if (!kept) lists.personal.entries = lists.personal.entries.filter((e) => e !== mine && !(e.ok && e.id === mine.id));
        const entry = readEntry(raw);
        lists.shared.entries.push(entry);
        notifyLibrary();
        await select(keyOf('shared', entry), { remember: true });
        if (kept) setStatus(`Shared, but the personal copy could not be removed: ${kept.message}`, true);
    }

    async function remove(entry, scope) {
        const message = scope === 'shared'
            ? `<p>Delete <b>${esc(entry.name || entry.id)}</b> for everyone on this project?</p><p>The change is in project.json until you commit it.</p>`
            : `<p>Delete your personal dashboard <b>${esc(entry.name || entry.id)}</b>?</p>`;
        const ok = await openConfirm({
            title: 'Delete dashboard', message, confirmLabel: 'Delete', danger: true, icon: 'delete',
        });
        if (!ok || disposed) return;
        clearTimeout(saveTimer);
        saveTimer = null;
        try { await store[scope].remove(entry.id); }
        catch (err) { setStatus(`Not deleted: ${err.message}`, true); return; }
        if (current?.id === entry.id && currentScope === scope) { current = null; }
        lists[scope].entries = lists[scope].entries.filter((e) => e !== entry && !(e.ok && e.id === entry.id));
        notifyLibrary();
        await select(firstKey(section), { remember: true });
    }

    /* ── start ──────────────────────────────────────────────────── */

    // Read the lists again on every open: another checkout's dashboards arrive
    // with a pull. The Navigator repaints from the same read.
    const hideLoading = makeLoadingOverlay(contentSlot);
    const ready = loadLibrary()
        .then(() => {
            hideLoading();
            if (disposed) return;
            if (!entryFor(selectedId)) selectedId = firstKey(section);
            setSelectedKey(selectedId, kind);
            return renderMain();
        });

    return {
        title: props.label || 'Dashboards',
        ready,
        /** For tests: the live grid, or null. */
        get grid() { return grid; },
        destroy: () => {
            if (saveTimer) flush();
            disposed = true;
            unfollow();
            if (selectedKey(kind) === selectedId) setSelectedKey(null, kind);
            clearTimeout(refreshTimer);
            for (const sub of subs) { try { sub?.dispose?.(); } catch { /* already gone */ } }
            disposeGrid();
            try { crumb?.destroy(); } catch { /* already gone */ }
        },
    };
}
