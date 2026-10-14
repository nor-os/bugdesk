/**
 * ticketdesk/changes_pane.js — the bottom panel's Changes tab: the store's
 * uncommitted record files, what changed in each, a message, Commit and Push.
 *
 * Only RECORD files are listed and committed — the bridge refuses anything else
 * (GitService.cs) — so a repo full of somebody's code in progress is never
 * swept into a record commit. Other changed files in the store's folders and
 * its `.bugdesk/` settings folder are NAMED under the list, so a dirty
 * `git status` is never a mystery, but never committed from here. Whether a
 * save commits by itself, and whether a commit pushes, are the two switches in
 * the bar's Auto group; they are the project's (`git` in project.json), off by
 * default.
 *
 * THE LIST. Grouped by store half (Bugs, Backlog — Tickets in TicketDesk), each
 * file as its ref and its record's title, with a one-glance summary ("1 field",
 * "+2 lines"). Each has a checkbox: Commit commits the ticked files only, and
 * says so ("Commit 2 of 3").
 *
 * THE DIFF, three ways (record_diff.js): FIELDS — front-matter values, "Severity
 * high → critical"; TEXT — the body, numbered as in the file, without git's
 * header lines; RAW GIT — what `git diff` says, for when the other two are not
 * enough. A file opens on Fields when a field changed, else on Text. From its
 * header the record opens, and Discard… throws its changes away after asking
 * (GitService.Discard: an edit is undone, a new file goes to the trash).
 *
 * SOURCES. A project page that shows the global tracker has two stores in two
 * repos (or none — a tracker usually lives outside any). The bottom panel hands
 * this pane one source per store copy (instance.js); the tracker's files are a
 * group of their own and are committed in the tracker's repo. The branch, the
 * Auto switches and Push are the first source's — the page's own.
 *
 * A push runs in the background on the bridge. Its result — git's own words
 * when it was rejected, had no remote or no credentials — is shown here; the
 * commit stays local and nothing is lost.
 */

import { esc } from './data.js';
import * as instance from './instance.js';
import { changeSummary, fieldChanges, textChanges } from './record_diff.js';

const { CONFIG, apiUrl, ev } = instance;

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

async function callAt(api, path, body) {
    const res = await fetch(api(path), body === undefined
        ? { headers: { accept: 'application/json' } }
        : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
    return j;
}
const call = (path, body) => callAt(apiUrl, path, body);

const STATUS_BADGE = { new: 'A', modified: 'M', deleted: 'D' };

/** Past this many files a source's summaries are not worked out (one diff each). */
const SUMMARY_LIMIT = 40;

/**
 * Mount the pane into `host`. Returns `{ refresh, destroy }`.
 * @param {HTMLElement} host
 * @param {object} [o]
 * @param {object} [o.eventBus]
 * @param {Array<{inst: object, alerts?: object}>} [o.sources]  store copies; the page's own by default
 * @param {(n:number) => void} [o.onCount]  told the number of changed records after every refresh
 */
export function mountChangesPane(host, { eventBus = null, sources = null, onCount = null } = {}) {
    const srcs = (sources?.length ? sources : [{ inst: instance }]).map((s) => ({
        ...s, api: s.inst.apiUrl, state: null, texts: new Map(),
    }));
    const main = srcs[0];
    let selected = null;            // `${sourceIndex}:${path}`
    let view = null;                // 'fields' | 'text' | 'raw' — null: chosen per file
    const off = new Set();          // keys left out of the next commit
    let message = '';
    let error = '';
    let busy = false;

    const keyOf = (si, path) => `${si}:${path}`;
    const fileOf = (key) => {
        if (!key) return null;
        const at = key.indexOf(':');
        const s = srcs[Number(key.slice(0, at))];
        const f = s?.state?.files?.find((x) => x.path === key.slice(at + 1));
        return f ? { s, si: Number(key.slice(0, at)), f } : null;
    };
    // In the order the list draws them: per source, its bugs before its backlog.
    const allFiles = () => srcs.flatMap((s, si) => (s.state?.enabled
        ? [...s.state.files].sort((a, b) => (a.store === 'bugs' ? 0 : 1) - (b.store === 'bugs' ? 0 : 1))
            .map((f) => ({ s, si, f, key: keyOf(si, f.path) }))
        : []));

    const loadTexts = async (s, f) => {
        if (s.texts.has(f.path)) return s.texts.get(f.path);
        const j = await callAt(s.api, `/git/diff?path=${encodeURIComponent(f.path)}`);
        const t = { diff: j.diff || '', before: j.before || '', after: j.after || '' };
        s.texts.set(f.path, t);
        return t;
    };

    /* ── drawing ─────────────────────────────────────────────────── */

    const fileRow = ({ s, f, key }) => {
        const t = s.texts.get(f.path);
        const summary = t ? changeSummary(t.before, t.after, f.status) : f.status;
        return `
            <div class="bd-changes__file${key === selected ? ' bd-changes__file--on' : ''}">
                <input type="checkbox" data-check="${esc(key)}" ${off.has(key) ? '' : 'checked'}
                    aria-label="Include ${esc(f.ref || f.path)} in the commit">
                <button type="button" class="bd-changes__pick" data-file="${esc(key)}">
                    <span class="bd-changes__badge bd-changes__badge--${esc(f.status)}" title="${esc(f.status)}">${STATUS_BADGE[f.status] || 'M'}</span>
                    <span class="bd-changes__ref">${esc(f.ref || f.path.split('/').pop())}</span>
                    <span class="bd-changes__title">${esc(f.title || '')}</span>
                    <span class="bd-changes__sum">${esc(summary)}</span>
                </button>
            </div>`;
    };

    const listHtml = () => {
        const groups = [];
        srcs.forEach((s, si) => {
            const st = s.state;
            if (!st) return;
            if (!st.enabled) {
                // One store: the whole pane says it (below). Several: the group does.
                if (srcs.length > 1) {
                    groups.push(`<div class="bd-changes__group">${esc(s.inst.storeLabelOf('backlog').toUpperCase())}</div>
                        <div class="bd-changes__note">${esc(st.reason || 'Not in a git repository, so there is nothing to commit.')}</div>`);
                }
                return;
            }
            const halves = s.inst.IS_TRACKER_COPY ? [['all', st.files]]
                : [['bugs', st.files.filter((f) => f.store === 'bugs')], ['backlog', st.files.filter((f) => f.store !== 'bugs')]];
            for (const [half, files] of halves) {
                if (!files.length) continue;
                groups.push(`<div class="bd-changes__group">${esc(s.inst.storeLabelOf(half).toUpperCase())}<span>${files.length}</span></div>`
                    + files.map((f) => fileRow({ s, f, key: keyOf(si, f.path) })).join(''));
            }
        });
        const any = allFiles().length > 0;
        return (groups.join('') || '') + (any ? '' : '<div class="td-dim bd-changes__empty">No uncommitted record files.</div>');
    };

    const othersHtml = () => {
        const others = srcs.flatMap((s) => (s.state?.enabled ? s.state.others || [] : []));
        if (!others.length) return '';
        const name = (p) => `<span class="td-mono">${esc(p)}</span>${/(^|\/)project\.json$/.test(p) ? ' (settings)' : ''}`;
        const shown = others.slice(0, 3).map(name).join(', ');
        return `<div class="bd-changes__others">${icon('info')}<span>Also changed, not a record: ${shown}${others.length > 3 ? ` and ${others.length - 3} more` : ''}</span></div>`;
    };

    const viewHtml = (f, t) => {
        if (view === 'raw') {
            return `<div class="bd-diff bd-diff--raw">${esc(t.diff) || '<span class="td-dim">No differences.</span>'}</div>`;
        }
        if (view === 'fields') {
            const fields = fieldChanges(t.before, t.after);
            if (!fields.length) return `<div class="td-dim bd-changes__hint">No field changes.${f.status === 'modified' ? ' The text changed: see Text.' : ''}</div>`;
            return `<div class="bd-fields">${fields.map((c) => `
                <span class="bd-fields__name">${esc(c.name)}</span>
                <span class="bd-fields__vals"><span class="bd-fields__from">${esc(c.from)}</span>${icon('arrow_forward')}<span class="bd-fields__to">${esc(c.to)}</span></span>`).join('')}</div>`;
        }
        const lines = textChanges(t.before, t.after);
        if (lines === null) return '<div class="td-dim bd-changes__hint">Too long to compare here: see Raw git.</div>';
        if (!lines.length) return '<div class="td-dim bd-changes__hint">The text below the fields did not change.</div>';
        return `<div class="bd-diff">${lines.map((l) => (l.gap
            ? '<div class="bd-diff__line bd-diff__line--gap"><span class="bd-diff__n">⋯</span></div>'
            : `<div class="bd-diff__line${l.sign === '+' ? ' bd-diff__line--add' : l.sign === '-' ? ' bd-diff__line--del' : ''}"><span class="bd-diff__n">${l.n}</span><span class="bd-diff__sign">${l.sign}</span><span class="bd-diff__text">${esc(l.text)}</span></div>`)).join('')}</div>`;
    };

    const detailHtml = () => {
        const hit = fileOf(selected);
        if (!hit) return '<div class="bd-changes__diff"><div class="td-dim bd-changes__hint">Pick a file to see what changed.</div></div>';
        const { s, f } = hit;
        const t = s.texts.get(f.path);
        const seg = (k, label) => `<button type="button" data-view="${k}" aria-pressed="${view === k}" class="bd-changes__seg${view === k ? ' bd-changes__seg--on' : ''}">${label}</button>`;
        const canOpen = !!s.alerts?.openRef && f.status !== 'deleted';
        return `
            <div class="bd-changes__dhead">
                <span class="bd-changes__ref">${esc(f.ref || f.path)}</span>
                <span class="bd-changes__dtitle">${esc(f.title || '')}</span>
                ${canOpen ? `<a href="#" class="bd-changes__open" data-open="${esc(selected)}">Open</a>` : ''}
                <span class="td-spacer"></span>
                <div class="bd-changes__segs" role="group" aria-label="Diff view">${seg('fields', 'Fields')}${seg('text', 'Text')}${seg('raw', 'Raw git')}</div>
                <button type="button" class="ea-btn bd-changes__discard" data-discard="${esc(selected)}" ${busy ? 'disabled' : ''}>Discard…</button>
            </div>
            <div class="bd-changes__diff" data-slot="diff">${t ? viewHtml(f, t) : '<span class="td-dim bd-changes__hint">Loading…</span>'}</div>`;
    };

    const barHtml = () => {
        const st = main.state;
        const s = st.settings || {};
        const ahead = st.ahead > 0 ? `${st.ahead} commit${st.ahead === 1 ? '' : 's'} not pushed`
            : st.ahead === 0 ? 'Up to date with its remote' : 'No remote branch, so nothing to push';
        return `
            <div class="bd-changes__bar">
                <span class="bd-changes__branch">${icon('fork_right')}${esc(st.branch || '?')}</span>
                <span class="td-dim">${esc(ahead)}</span>
                <span class="td-spacer"></span>
                <div class="bd-changes__auto" role="group" aria-label="Automatic commits">
                    <span class="bd-changes__autolabel">AUTO</span>
                    <label class="td-check" title="Every save in ${esc(CONFIG.appName || 'BugDesk')} commits the record it wrote">
                        <input type="checkbox" data-set="commitAfterSave" ${s.commitAfterSave ? 'checked' : ''}> Commit on save</label>
                    <label class="td-check" title="Every such commit is pushed straight after">
                        <input type="checkbox" data-set="pushAfterCommit" ${s.pushAfterCommit ? 'checked' : ''} ${s.commitAfterSave ? '' : 'disabled'}> Push after commit</label>
                </div>
                <button type="button" class="bd-changes__icon" data-act="refresh" aria-label="Refresh" title="Refresh">${icon('refresh')}</button>
            </div>`;
    };

    const placeholder = (picked) => (picked.length
        ? `${picked.map((x) => x.f.ref || x.f.path.split('/').pop()).join(', ')}: record edits from the UI`
        : 'Pick at least one file to commit');

    const commitHtml = () => {
        const files = allFiles();
        const picked = files.filter((x) => !off.has(x.key));
        const st = main.state;
        const pushOff = !st.enabled || st.ahead === -1 || (st.ahead === 0 && !st.pushing);
        const pushWhy = !st.enabled ? 'This store is not in a git repository'
            : st.ahead === -1 ? 'No remote branch to push to' : st.ahead === 0 ? 'Nothing to push' : '';
        const label = picked.length === files.length ? `Commit ${files.length || ''}` : `Commit ${picked.length} of ${files.length}`;
        return `
            <div class="bd-changes__commit">
                <input class="ea-tin" data-slot="message" aria-label="Commit message" value="${esc(message)}" placeholder="${esc(placeholder(picked))}">
                <button type="button" class="ea-btn ea-btn--primary" data-act="commit" ${picked.length && !busy ? '' : 'disabled'}>${icon('commit')} ${label.trim()}</button>
                <button type="button" class="ea-btn" data-act="push" ${busy || st.pushing || pushOff ? 'disabled' : ''} ${pushWhy ? `title="${esc(pushWhy)}"` : ''}>${icon('cloud_upload')} ${st.pushing ? 'Pushing…' : 'Push'}</button>
            </div>`;
    };

    const messagesHtml = () => {
        const push = main.state.lastPush;
        return `${error ? `<div class="bd-changes__msg bd-changes__msg--err" role="alert">${icon('error')} <pre>${esc(error)}</pre></div>` : ''}
            ${push ? `<div class="bd-changes__msg ${push.ok ? 'bd-changes__msg--ok' : 'bd-changes__msg--err'}">${icon(push.ok ? 'cloud_done' : 'cloud_off')}
                <span>Last push ${new Date(push.at).toLocaleTimeString()}: ${push.ok ? 'done.' : 'failed — the commit is still here, nothing is lost.'}</span>
                <pre>${esc(push.message)}</pre></div>` : ''}`;
    };

    const render = () => {
        if (srcs.some((s) => !s.state)) { host.innerHTML = '<div class="td-dim bd-changes__empty">Loading…</div>'; return; }
        if (srcs.every((s) => !s.state.enabled)) {
            host.innerHTML = `<div class="bd-changes bd-changes--off">${icon('info')} ${esc(main.state.reason || 'Git is not available here.')}
                <div class="td-dim">Commit on save and push after commit are switched off for this store.</div></div>`;
            return;
        }
        // Keep the caret where it was: a refresh while somebody types the
        // message must not throw them out of the field.
        const typing = document.activeElement?.dataset?.slot === 'message' && host.contains(document.activeElement);
        const caret = typing ? document.activeElement.selectionStart : null;
        const scroll = host.querySelector('.bd-changes__list')?.scrollTop ?? 0;
        host.innerHTML = `
            <div class="bd-changes">
                ${main.state.enabled ? barHtml() : ''}
                <div class="bd-changes__body">
                    <div class="bd-changes__files">
                        <div class="bd-changes__list">${listHtml()}</div>
                        ${othersHtml()}
                    </div>
                    <div class="bd-changes__detail">${detailHtml()}</div>
                </div>
                ${commitHtml()}
                ${messagesHtml()}
            </div>`;
        const list = host.querySelector('.bd-changes__list');
        if (list) list.scrollTop = scroll;
        if (typing) {
            const input = host.querySelector('[data-slot="message"]');
            input?.focus();
            input?.setSelectionRange(caret, caret);
        }
    };

    /* ── data ────────────────────────────────────────────────────── */

    const choose = async (key) => {
        selected = key;
        view = null;
        render();
        const hit = fileOf(key);
        if (!hit) return;
        try {
            const t = await loadTexts(hit.s, hit.f);
            if (selected !== key) return;
            view = fieldChanges(t.before, t.after).length ? 'fields' : 'text';
        } catch (err) {
            error = `Could not read the diff: ${err.message}`;
        }
        render();
    };

    let generation = 0;
    const refresh = async () => {
        const gen = ++generation;
        await Promise.all(srcs.map(async (s) => {
            try { s.state = await callAt(s.api, '/git'); }
            catch (err) { s.state = { enabled: false, files: [], reason: `Could not ask the bridge about git: ${err.message}` }; }
            s.texts.clear();
        }));
        if (gen !== generation) return;
        const files = allFiles();
        onCount?.(files.length);
        for (const k of [...off]) if (!files.some((x) => x.key === k)) off.delete(k);
        if (selected && !fileOf(selected)) { selected = null; view = null; }
        if (!selected && files.length) selected = files[0].key;
        render();
        // The summaries need each file's two versions; one small request a file.
        await Promise.all(files.slice(0, SUMMARY_LIMIT).map((x) => loadTexts(x.s, x.f).catch(() => null)));
        if (gen !== generation) return;
        const cur = fileOf(selected);
        if (cur && view === null) {
            const t = cur.s.texts.get(cur.f.path);
            if (t) view = fieldChanges(t.before, t.after).length ? 'fields' : 'text';
        }
        render();
    };

    /* ── doing ───────────────────────────────────────────────────── */

    const commit = async () => {
        const picked = allFiles().filter((x) => !off.has(x.key));
        if (!picked.length) return;
        const msg = message.trim() || placeholder(picked);
        // One commit per repo: the tracker's files go to the tracker's.
        for (const s of srcs) {
            const files = picked.filter((x) => x.s === s).map((x) => x.f.path);
            if (files.length) s.state = await callAt(s.api, '/git/commit', { message: msg, files });
        }
        message = '';
        selected = null;
    };

    const discard = async (key) => {
        const hit = fileOf(key);
        if (!hit) return;
        const { s, f } = hit;
        const { openConfirm } = await import('@flexdesk/widgets');
        const what = f.status === 'new'
            ? `<p><b>${esc(f.ref)}</b> is new and was never committed.</p><p class="td-dim">Discarding moves the file to the trash folder beside the store.</p>`
            : f.status === 'deleted'
                ? `<p>Bring back <b>${esc(f.ref)} — ${esc(f.title || '')}</b> as it was last committed?</p>`
                : `<p>Discard your changes to <b>${esc(f.ref)} — ${esc(f.title || '')}</b>?</p><p class="td-dim">It goes back to how it was last committed. This cannot be undone.</p>`;
        const ok = await openConfirm({
            title: f.status === 'deleted' ? `Restore ${f.ref}` : `Discard changes to ${f.ref}`,
            message: what, confirmLabel: f.status === 'deleted' ? 'Restore' : 'Discard', danger: f.status !== 'deleted', icon: 'undo',
        });
        if (!ok) return;
        s.state = await callAt(s.api, '/git/discard', { path: f.path });
    };

    host.addEventListener('click', async (e) => {
        const pick = e.target.closest('[data-file]');
        if (pick) { choose(pick.dataset.file); return; }
        const seg = e.target.closest('[data-view]');
        if (seg) { view = seg.dataset.view; render(); return; }
        const open = e.target.closest('[data-open]');
        if (open) {
            e.preventDefault();
            const hit = fileOf(open.dataset.open);
            if (hit) hit.s.alerts?.openRef?.(hit.f.ref);
            return;
        }
        const disc = e.target.closest('[data-discard]')?.dataset.discard;
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!disc && !act) return;
        if (act === 'refresh') { refresh(); return; }
        busy = true; error = '';
        render();
        try {
            if (disc) await discard(disc);
            else if (act === 'commit') await commit();
            else if (act === 'push') main.state = await callAt(main.api, '/git/push', {});
        } catch (err) { error = err.message; }
        busy = false;
        await refresh();
    });

    host.addEventListener('input', (e) => {
        if (e.target.dataset?.slot !== 'message') return;
        message = e.target.value;
    });

    host.addEventListener('change', async (e) => {
        const check = e.target.dataset?.check;
        if (check) {
            if (e.target.checked) off.delete(check); else off.add(check);
            render();
            return;
        }
        const key = e.target.dataset?.set;
        if (!key) return;
        const next = { ...(main.state?.settings || {}), [key]: e.target.checked };
        if (!next.commitAfterSave) next.pushAfterCommit = false;
        try { main.state = await callAt(main.api, '/project/git', next); error = ''; }
        catch (err) { error = err.message; }
        render();
    });

    const names = new Set(['bugs:changed']);
    for (const s of srcs) for (const n of ['backlog:changed', 'git:changed', 'store:changed']) names.add(s.inst.ev(n));
    let soon = null;
    const later = () => { clearTimeout(soon); soon = setTimeout(refresh, 150); };
    const subs = [...names].map((name) => eventBus?.on?.(name, later));
    // A push finishing is announced by the bridge; this covers a bridge too old
    // to say so, and a push started elsewhere.
    const timer = setInterval(() => { if (srcs.some((s) => s.state?.pushing)) refresh(); }, 2000);

    render();
    refresh();
    return {
        refresh,
        destroy() {
            clearInterval(timer);
            clearTimeout(soon);
            for (const s of subs) { try { s?.dispose?.(); s?.(); } catch { /* gone */ } }
        },
    };
}

/**
 * Settings › Git: the same two switches as the pane's, on the Settings page
 * (STORY-0032). Each applies as it is flipped, as in the pane. Auto-save is not
 * here any more: it is each person's own, under Settings › Behaviour.
 * @param {HTMLElement} el
 * @param {object} [o]
 * @param {object} [o.eventBus]
 * @returns {Promise<() => void>} cleanup
 */
export async function mountGitSettings(el, { eventBus = null } = {}) {
    let state;
    let error = '';
    try { state = await call('/git'); } catch (err) { state = { enabled: false, reason: err.message }; }
    const render = () => {
        if (!state.enabled) {
            el.innerHTML = `<p class="td-dim">${esc(state.reason || 'Git is not available here.')}</p>`;
            return;
        }
        const s = state.settings || {};
        el.innerHTML = `
            <div class="bd-git-settings">
                <label class="bd-git-settings__row">
                    <input type="checkbox" data-set="commitAfterSave" ${s.commitAfterSave ? 'checked' : ''}>
                    <span><b>Commit after save</b><span class="td-dim">Every save commits the record it wrote — that file only — as BUG-0042: record edits from the UI. Auto-saves commit once you leave the record, or after five quiet minutes.</span></span>
                </label>
                <label class="bd-git-settings__row">
                    <input type="checkbox" data-set="pushAfterCommit" ${s.pushAfterCommit ? 'checked' : ''} ${s.commitAfterSave ? '' : 'disabled'}>
                    <span><b>Push after commit</b><span class="td-dim">Each of those commits is pushed straight after. A failed push is shown in the Changes tab.</span></span>
                </label>
                ${error ? `<div class="bd-schema__problems" role="alert"><span class="material-symbols-outlined">error</span><span>Not saved: ${esc(error)}</span></div>` : ''}
                <div class="td-dim bd-schema__foot">Saved to .bugdesk/project.json — commit it to share it. The bottom panel's Changes tab lists what is uncommitted, and commits and pushes by hand.</div>
            </div>`;
    };
    const onChange = async (e) => {
        const key = e.target.dataset?.set;
        if (!key) return;
        // Only the two switches: the project's auto-save is left as it is.
        const cur = state.settings || {};
        const next = { commitAfterSave: !!cur.commitAfterSave, pushAfterCommit: !!cur.pushAfterCommit, [key]: e.target.checked };
        if (!next.commitAfterSave) next.pushAfterCommit = false;
        try {
            state = await call('/project/git', next);
            error = '';
            CONFIG.saving = { ...(CONFIG.saving || {}), commitAfterSave: state.settings.commitAfterSave, pushAfterCommit: state.settings.pushAfterCommit };
            eventBus?.emit?.(ev('git:changed'), {});
        } catch (err) { error = err.message; }
        render();
    };
    el.addEventListener('change', onChange);
    render();
    return () => el.removeEventListener('change', onChange);
}
