/**
 * git_diff_modal.js — modal showing the unified diff for a file.
 *
 * Triggered by GitPanel's `onOpenDiff` callback. Fetches the working-
 * tree diff (and the staged diff, when distinct) and renders them with
 * +/-/@@ colouring. Built on `openModal` for consistent chrome.
 */

import { openModal } from './modal.js';


export async function openGitDiffModal({ filePath, status } = {}) {
    const content = document.createElement('div');
    content.className = 'ea-git-diff-modal__body';
    if (status) {
        const sub = document.createElement('div');
        sub.className = 'ea-modal__hint';
        sub.textContent = status;
        content.appendChild(sub);
    }
    const host = document.createElement('div');
    host.innerHTML = '<div class="ea-plot__placeholder">Loading diff…</div>';
    content.appendChild(host);

    const promise = openModal({
        title:   String(filePath || 'Diff'),
        icon:    'difference',
        content,
        width:   880,
        height:  600,
        actions: [{ label: 'Close', value: null, primary: true }],
    });

    // Fetch staged + working-tree diffs in parallel after the modal
    // is on screen so the user sees "Loading…" rather than a blank
    // window during the round-trip.
    (async () => {
        let working = '', staged = '';
        try {
            const [r1, r2] = await Promise.all([
                window.pywebview?.api?.git_diff?.({ filePath, staged: false }),
                window.pywebview?.api?.git_diff?.({ filePath, staged: true  }),
            ]);
            working = r1?.diff || '';
            staged  = r2?.diff || '';
        } catch { /* ignore */ }
        host.innerHTML = `
            ${working ? `
                <section class="ea-git-diff__section">
                    <h4>Working tree</h4>
                    <pre class="ea-git-diff__body">${formatDiff(working)}</pre>
                </section>` : ''}
            ${staged ? `
                <section class="ea-git-diff__section">
                    <h4>Staged</h4>
                    <pre class="ea-git-diff__body">${formatDiff(staged)}</pre>
                </section>` : ''}
            ${!working && !staged
                ? '<div class="ea-plot__placeholder">No diff for this file.</div>'
                : ''}
        `;
    })();

    return promise;
}


function formatDiff(text) {
    return esc(text)
        .split('\n')
        .map((line) => {
            if (line.startsWith('+++') || line.startsWith('---'))
                return `<span class="ea-git-diff__meta">${line}</span>`;
            if (line.startsWith('@@'))
                return `<span class="ea-git-diff__hunk">${line}</span>`;
            if (line.startsWith('+'))
                return `<span class="ea-git-diff__add">${line}</span>`;
            if (line.startsWith('-'))
                return `<span class="ea-git-diff__del">${line}</span>`;
            return line;
        })
        .join('\n');
}


function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
