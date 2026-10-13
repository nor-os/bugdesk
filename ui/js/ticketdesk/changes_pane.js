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
 * Settings › Saving and git: the same two switches as the pane's, in a dialog.
 * Resolves true once saved.
 */
export async function openGitSettings({ eventBus = null } = {}) {
    let state;
    try { state = await call('/git'); } catch (err) { state = { enabled: false, reason: err.message }; }
    const { openForm, openConfirm } = await import('../ui/components/modal.js');
    if (!state.enabled) {
        await openConfirm({ title: 'Saving and git', message: `<p>${esc(state.reason || 'Git is not available here.')}</p>`,
            confirmLabel: 'OK' });
        return false;
    }
    const answer = await openForm({
        title: 'Saving and git',
        fields: [
            { name: 'commitAfterSave', label: 'Commit after save', type: 'checkbox',
              hint: 'Every save commits the record it wrote — that file only — as BUG-0042: record edits from the UI.' },
            { name: 'pushAfterCommit', label: 'Push after commit', type: 'checkbox',
              hint: 'Each of those commits is pushed straight after. A failed push is shown in the Changes pane.' },
            { section: 'Auto-save' },
            { name: 'autosave', label: 'Save edits', type: 'select', required: true,
              options: [{ value: 'off', label: 'Only when I press Save' },
                        { value: 'debounce', label: 'A few seconds after I stop typing' },
                        { value: 'interval', label: 'Every few seconds while there are edits' }] },
            { name: 'autosaveSeconds', label: 'Seconds', type: 'number',
              hint: 'How long after the last keystroke, or how often. Auto-saves commit once you leave the record, or after five quiet minutes.' },
        ],
        defaults: state.settings || {},
        submitLabel: 'Save',
    });
    if (!answer) return false;
    try {
        const saved = await call('/project/git', {
            commitAfterSave: !!answer.commitAfterSave, pushAfterCommit: !!answer.pushAfterCommit,
            autosave: answer.autosave || 'off', autosaveSeconds: Number(answer.autosaveSeconds) || 0,
        });
        // The pages read the mode at mount: a page opened from now on uses it.
        CONFIG.saving = saved.settings;
        eventBus?.emit?.(ev('git:changed'), {});
        return true;
    } catch (err) {
        eventBus?.emit?.('toast:show', { type: 'error', message: `Could not save: ${err.message}` });
        return false;
    }
}
