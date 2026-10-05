/**
 * ticketdesk/comment_edit.js — editing a comment that is already in a thread.
 *
 * Shared by the bug page and the backlog item page: both draw their thread
 * newest first, and both hand this module the comments in FILE order, which is
 * what the bridge addresses an edit by. Each entry carries `data-cidx` (its
 * file-order index); the pencil in its header swaps the rendered text for the
 * markdown editor, and Save posts `{ date, author, body }` for that index.
 *
 * ONLY THE TEXT CHANGES. The header — who wrote it, when, and the status move it
 * was the message for — stays as it was, so a thread that read as a history of
 * decisions still does. The bridge refuses the edit when the comment at that
 * index no longer has the date and author the page showed: a comment appended
 * or edited elsewhere in the meantime must not inherit somebody else's text.
 */

import { editRecordComment } from './data.js';
import { attachMarkdownEditor } from './md_editor.js';

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

/** The pencil a comment header carries. */
export const editButtonHTML = () =>
    `<button type="button" class="td-wentry__edit ea-btn ea-btn--small" data-a="edit-comment"
             title="Edit this comment">${icon('edit')}</button>`;

/**
 * Wire the pencils inside `streamEl`.
 *
 * @param {HTMLElement} streamEl   the element holding the `[data-cidx]` entries
 * @param {object} o
 * @param {Array}    o.comments    the thread in FILE order (oldest first)
 * @param {string}   o.path        `/bugs/<id>` or `/backlog/<id>`
 * @param {Function} o.onSaved     `(bridgeAnswer) => void` — re-render from it
 * @param {Function} [o.onStatus]
 * @returns {{ destroy(): void }}
 */
export function attachCommentEditing(streamEl, { comments, path, onSaved, onStatus = null }) {
    const say = (m) => { try { onStatus?.(m); } catch { /* advisory */ } };
    let open = null;   // { entry, editor, textEl, host }

    const close = () => {
        if (!open) return;
        try { open.editor.destroy(); } catch { /* already gone */ }
        open.host.remove();
        open.textEl.hidden = false;
        open = null;
    };

    const start = (entry) => {
        close();
        const idx = Number(entry.dataset.cidx);
        const c = comments[idx];
        const textEl = entry.querySelector('.td-wentry__text');
        if (!c || !textEl) return;
        const host = document.createElement('div');
        host.className = 'td-wentry__editor';
        host.innerHTML = `<textarea class="ea-tin td-area" rows="3"></textarea>
            <div class="td-wentry__editbar">
                <button type="button" class="ea-btn" data-a="edit-cancel">Cancel</button>
            </div>`;
        const ta = host.querySelector('textarea');
        ta.value = c.body || '';
        textEl.hidden = true;
        textEl.after(host);
        const save = async (text) => {
            if (!text) { say('A comment cannot be empty.'); return; }
            if (text === String(c.body || '').trim()) { close(); return; }
            try {
                const answer = await editRecordComment(path, idx, c, text);
                close();
                say('Comment updated.');
                onSaved(answer);
            } catch (err) { say(`Edit failed: ${err.message}`); }
        };
        const editor = attachMarkdownEditor(ta, { onSubmit: save, submitLabel: 'Save', submitIcon: 'check', onStatus });
        open = { entry, editor, textEl, host };
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
    };

    const onClick = (e) => {
        const btn = e.target.closest('[data-a="edit-comment"], [data-a="edit-cancel"]');
        if (!btn || !streamEl.contains(btn)) return;
        if (btn.dataset.a === 'edit-cancel') { close(); return; }
        const entry = btn.closest('[data-cidx]');
        if (entry) start(entry);
    };
    const onKey = (e) => { if (e.key === 'Escape' && open && open.host.contains(e.target)) { e.stopPropagation(); close(); } };
    streamEl.addEventListener('click', onClick);
    streamEl.addEventListener('keydown', onKey);
    return {
        destroy() {
            close();
            streamEl.removeEventListener('click', onClick);
            streamEl.removeEventListener('keydown', onKey);
        },
    };
}
