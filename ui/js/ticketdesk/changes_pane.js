/**
 * ticketdesk/changes_pane.js — the bottom panel's Changes tab: the store's
 * uncommitted record files, each with its diff, a message, Commit and Push.
 *
 * Only RECORD files are listed and committed — the bridge refuses anything else
 * (GitService.cs) — so a repo full of somebody's code in progress is never
 * swept into a record commit. Whether a save commits by itself, and whether a
 * commit pushes, are the two switches at the top; they are the project's
 * (`git` in project.json), off by default.
 *
 * A push runs in the background on the bridge. Its result — git's own words
 * when it was rejected, had no remote or no credentials — is shown here; the
 * commit stays local and nothing is lost.
 */

import { esc } from './data.js';
import { CONFIG, apiUrl, ev } from './instance.js';

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

async function call(path, body) {
    const res = await fetch(apiUrl(path), body === undefined
        ? { headers: { accept: 'application/json' } }
        : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
    return j;
}

const STATUS_ICON = { new: 'add_circle', modified: 'edit', deleted: 'remove_circle' };

/** Mount the pane into `host`. Returns `{ refresh, destroy }`. */
export function mountChangesPane(host, { eventBus = null } = {}) {
    let state = null;
    let selected = null;
    let error = '';
    let busy = false;

    const diffHtml = (text) => String(text || '').split('\n').map((l) => {
        const cls = l.startsWith('+') && !l.startsWith('+++') ? 'add'
            : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
        return `<div class="bd-diff__line${cls ? ` bd-diff__line--${cls}` : ''}">${esc(l) || '&nbsp;'}</div>`;
    }).join('');

    const render = () => {
        if (!state) { host.innerHTML = '<div class="td-dim bd-changes__empty">Loading…</div>'; return; }
        if (!state.enabled) {
            host.innerHTML = `<div class="bd-changes bd-changes--off">${icon('info')} ${esc(state.reason || 'Git is not available here.')}
                <div class="td-dim">Commit after save and push after commit are switched off for this store.</div></div>`;
            return;
        }
        const s = state.settings || {};
        const push = state.lastPush;
        const ahead = state.ahead > 0 ? `${state.ahead} commit${state.ahead === 1 ? '' : 's'} not pushed` : (state.ahead === 0 ? 'up to date with its remote' : 'no remote branch');
        host.innerHTML = `
        <div class="bd-changes">
            <div class="bd-changes__bar">
                <span class="td-mono">${icon('fork_right')} ${esc(state.branch || '?')}</span>
                <span class="td-dim">· ${esc(ahead)}</span>
                <span class="td-spacer"></span>
                <label class="td-check" title="Every save in BugDesk commits the record it wrote, as BUG-0042: record edits from the UI">
                    <input type="checkbox" data-set="commitAfterSave" ${s.commitAfterSave ? 'checked' : ''}> Commit after save</label>
                <label class="td-check" title="Every such commit is pushed straight after">
                    <input type="checkbox" data-set="pushAfterCommit" ${s.pushAfterCommit ? 'checked' : ''} ${s.commitAfterSave ? '' : 'disabled'}> Push after commit</label>
            </div>
            <div class="bd-changes__body">
                <div class="bd-changes__files">
                    ${state.files.length ? state.files.map((f) => `
                        <button type="button" class="bd-changes__file${f.path === selected ? ' bd-changes__file--on' : ''}" data-file="${esc(f.path)}">
                            ${icon(STATUS_ICON[f.status] || 'edit')}<span class="td-mono">${esc(f.path.split('/').pop())}</span>
                            <span class="td-dim">${esc(f.status)}</span></button>`).join('')
                        : '<div class="td-dim bd-changes__empty">No uncommitted record files.</div>'}
                </div>
                <div class="bd-changes__diff" data-slot="diff">${selected ? '<span class="td-dim">Loading…</span>' : '<span class="td-dim">Pick a file to see its changes.</span>'}</div>
            </div>
            <div class="bd-changes__commit">
                <input class="ea-tin" data-slot="message" placeholder="${state.files.length === 1 ? `${esc(state.files[0].path.split('/').pop().replace(/\.md$/, ''))}: record edits from the UI` : 'Record edits from the UI'}">
                <button type="button" class="ea-btn ea-btn--primary" data-act="commit" ${state.files.length && !busy ? '' : 'disabled'}>${icon('commit')} Commit ${state.files.length || ''}</button>
                <button type="button" class="ea-btn" data-act="push" ${busy || state.pushing ? 'disabled' : ''}>${icon('cloud_upload')} ${state.pushing ? 'Pushing…' : 'Push'}</button>
            </div>
            ${error ? `<div class="bd-changes__msg bd-changes__msg--err" role="alert">${icon('error')} <pre>${esc(error)}</pre></div>` : ''}
            ${push ? `<div class="bd-changes__msg ${push.ok ? 'bd-changes__msg--ok' : 'bd-changes__msg--err'}">${icon(push.ok ? 'cloud_done' : 'cloud_off')}
                <span>Last push ${new Date(push.at).toLocaleTimeString()}: ${push.ok ? 'done.' : 'failed — the commit is still here, nothing is lost.'}</span>
                <pre>${esc(push.message)}</pre></div>` : ''}
        </div>`;
        if (selected) showDiff(selected);
    };

    const showDiff = async (path) => {
        try {
            const j = await call(`/git/diff?path=${encodeURIComponent(path)}`);
            const el = host.querySelector('[data-slot="diff"]');
            if (el && selected === path) el.innerHTML = `<div class="bd-diff">${diffHtml(j.diff) || '<span class="td-dim">No differences.</span>'}</div>`;
        } catch (err) {
            const el = host.querySelector('[data-slot="diff"]');
            if (el) el.textContent = `Could not read the diff: ${err.message}`;
        }
    };

    const refresh = async () => {
        try { state = await call('/git'); }
        catch (err) { state = { enabled: false, reason: `Could not ask the bridge about git: ${err.message}` }; }
        if (selected && !state.files?.some((f) => f.path === selected)) selected = null;
        render();
    };

    host.addEventListener('click', async (e) => {
        const file = e.target.closest('[data-file]');
        if (file) { selected = file.dataset.file; render(); return; }
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        busy = true; error = '';
        try {
            if (act === 'commit') {
                const message = host.querySelector('[data-slot="message"]')?.value?.trim() || '';
                state = await call('/git/commit', { message });
                selected = null;
            } else if (act === 'push') {
                state = await call('/git/push', {});
            }
        } catch (err) { error = err.message; }
        busy = false;
        render();
    });

    host.addEventListener('change', async (e) => {
        const key = e.target.dataset?.set;
        if (!key) return;
        const next = { ...(state?.settings || {}), [key]: e.target.checked };
        if (!next.commitAfterSave) next.pushAfterCommit = false;
        try { state = await call('/project/git', next); error = ''; }
        catch (err) { error = err.message; }
        render();
    });

    const subs = ['bugs:changed', ev('backlog:changed'), ev('git:changed'), ev('store:changed')]
        .map((name) => eventBus?.on?.(name, () => refresh()));
    // A push finishing is announced by the bridge; this covers a bridge too old
    // to say so, and a push started elsewhere.
    const timer = setInterval(() => { if (state?.pushing) refresh(); }, 2000);

    render();
    refresh();
    return {
        refresh,
        destroy() {
            clearInterval(timer);
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
