/**
 * md_editor.js — the markdown composer behind bug descriptions and comments.
 *
 * A SOURCE editor, not a WYSIWYG one. SixShare's notes plugin gets its
 * richness from Milkdown/ProseMirror, which needs React and a bundler;
 * BugDesk loads plain ES modules straight from disk with no build step, so
 * the trade taken here is: keep the same control VOCABULARY (block styles,
 * inline marks, insert group, table tools, images) and apply it to the
 * textarea's own selection. The markdown stays the thing the user edits,
 * which also means the .md file on disk is always exactly what was typed.
 *
 * What it adds to a bare <textarea>:
 *   - a toolbar whose commands operate on the current selection
 *   - Enter submits, Alt+Enter (or Shift+Enter) inserts a newline
 *   - Ctrl+B / Ctrl+I / Ctrl+K for bold / italic / link
 *   - images by toolbar, by PASTE, and by DRAG-AND-DROP — uploaded to the
 *     bridge and inserted as `![name](/attachments/…)`
 *   - auto-growing height, so a long comment stops being a 2-line peephole
 *
 * Every command is undo-friendly: edits go through `document.execCommand`
 * where available, so Ctrl+Z still walks back through them rather than
 * wiping the field in one step.
 */

const icon = (name) => `<span class="material-symbols-outlined">${name}</span>`;

/* ── toolbar definition ─────────────────────────────────────────────
 * `cmd` names a handler in COMMANDS below. Groups are rendered with a
 * separator between them. Titles carry the shortcut where one exists. */
const TOOLBAR = [
    [
        { cmd: 'h1',      title: 'Heading 1',        text: 'H1' },
        { cmd: 'h2',      title: 'Heading 2',        text: 'H2' },
        { cmd: 'h3',      title: 'Heading 3',        text: 'H3' },
        { cmd: 'quote',   title: 'Blockquote',       icon: 'format_quote' },
        { cmd: 'bullet',  title: 'Bullet list',      icon: 'format_list_bulleted' },
        { cmd: 'ordered', title: 'Numbered list',    icon: 'format_list_numbered' },
        { cmd: 'task',    title: 'Task list item',   icon: 'checklist' },
    ],
    [
        { cmd: 'bold',    title: 'Bold (Ctrl+B)',    icon: 'format_bold' },
        { cmd: 'italic',  title: 'Italic (Ctrl+I)',  icon: 'format_italic' },
        { cmd: 'strike',  title: 'Strikethrough',    icon: 'strikethrough_s' },
        { cmd: 'code',    title: 'Inline code',      icon: 'code' },
        { cmd: 'link',    title: 'Link (Ctrl+K)',    icon: 'link' },
    ],
    [
        { cmd: 'image',   title: 'Insert image — or just paste / drop one', icon: 'image' },
        { cmd: 'table',   title: 'Insert table',     icon: 'table' },
        { cmd: 'codeblock', title: 'Code block',     icon: 'data_object' },
        { cmd: 'hr',      title: 'Horizontal rule',  icon: 'horizontal_rule' },
    ],
];

/* ── selection primitives ───────────────────────────────────────────
 * All of them read/write the textarea's value through `replaceRange`, so
 * the browser's own undo stack keeps working. */

/** Replace [start,end) with `text` and leave the caret/selection where
 *  `selStart`/`selEnd` say (absolute offsets in the NEW value). */
function replaceRange(ta, start, end, text, selStart, selEnd) {
    ta.focus();
    ta.setSelectionRange(start, end);
    // execCommand is deprecated but remains the ONLY way to write to a
    // textarea while preserving native undo. The fallback keeps the editor
    // working where it has been removed, at the cost of a coarser Ctrl+Z.
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
    if (!ok) {
        ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    }
    ta.setSelectionRange(selStart ?? start + text.length, selEnd ?? selStart ?? start + text.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Wrap the selection in `before`/`after`, or unwrap when it already is.
 *  With no selection, inserts the pair and parks the caret between them. */
function wrapSelection(ta, before, after = before, placeholder = '') {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    const sel = v.slice(s, e);

    // Already wrapped — toggle off, whether the markers are inside the
    // selection or hugging it.
    if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length) {
        const inner = sel.slice(before.length, sel.length - after.length);
        replaceRange(ta, s, e, inner, s, s + inner.length);
        return;
    }
    if (v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
        replaceRange(ta, s - before.length, e + after.length, sel, s - before.length, s - before.length + sel.length);
        return;
    }

    const body = sel || placeholder;
    const text = before + body + after;
    replaceRange(ta, s, e, text, s + before.length, s + before.length + body.length);
}

/** Line range covering the selection, snapped to line boundaries. */
function lineRange(ta) {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    const start = v.lastIndexOf('\n', s - 1) + 1;
    let end = v.indexOf('\n', e);
    if (end === -1) end = v.length;
    return { start, end };
}

/** Add `prefix` to every selected line, or strip it when every line has it.
 *  `ordered` renumbers instead of repeating the same marker. */
function prefixLines(ta, prefix, { ordered = false } = {}) {
    const { start, end } = lineRange(ta);
    const lines = ta.value.slice(start, end).split('\n');
    const has = (l) => (ordered ? /^\s*\d+[.)]\s+/.test(l) : l.startsWith(prefix));
    const allHave = lines.every((l) => !l.trim() || has(l));

    const next = lines.map((l, i) => {
        if (!l.trim()) return l;
        if (allHave) return ordered ? l.replace(/^\s*\d+[.)]\s+/, '') : l.slice(prefix.length);
        return (ordered ? `${i + 1}. ` : prefix) + l;
    }).join('\n');

    replaceRange(ta, start, end, next, start, start + next.length);
}

/** Insert a standalone block, guaranteeing a blank line on both sides. */
function insertBlock(ta, text, { caretOffset = null } = {}) {
    const { selectionStart: s, value: v } = ta;
    const atLineStart = s === 0 || v[s - 1] === '\n';
    const lead = atLineStart ? (s > 1 && v[s - 2] !== '\n' ? '\n' : '') : '\n\n';
    const trail = v[s] === undefined || v[s] === '\n' ? '\n' : '\n\n';
    const full = lead + text + trail;
    const caret = caretOffset == null ? s + full.length : s + lead.length + caretOffset;
    replaceRange(ta, s, ta.selectionEnd, full, caret, caret);
}

const TABLE_SKELETON = [
    '| Column | Column | Column |',
    '| --- | --- | --- |',
    '|  |  |  |',
    '|  |  |  |',
].join('\n');

/* ── image upload ───────────────────────────────────────────────── */

/** Read a File as base64 (no data: prefix). */
function toBase64(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onerror = () => reject(new Error(`could not read ${file.name || 'image'}`));
        fr.onload = () => {
            const res = String(fr.result || '');
            const comma = res.indexOf(',');
            resolve(comma >= 0 ? res.slice(comma + 1) : res);
        };
        fr.readAsDataURL(file);
    });
}

/** POST an image to the bridge; resolves to its `/attachments/…` URL. */
export async function uploadImage(file) {
    const data = await toBase64(file);
    const res = await fetch('/api/attachments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name || 'image', contentType: file.type || '', data }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new Error(j?.error || `upload failed (${res.status})`);
    return j.url;
}

/* ── mount ──────────────────────────────────────────────────────── */

/**
 * Decorate an existing <textarea> with the toolbar and behaviours.
 *
 * @param {HTMLTextAreaElement} ta
 * @param {object} opts
 * @param {Function} [opts.onSubmit]  called with the trimmed value; presence
 *        is what turns Enter into "post" and renders the submit button.
 * @param {string}  [opts.submitLabel='Comment']
 * @param {string}  [opts.submitIcon='send']
 * @param {Function}[opts.onStatus]   status-line sink for upload progress.
 * @returns {{destroy: Function, setBusy: Function, textarea: HTMLTextAreaElement}}
 */
export function attachMarkdownEditor(ta, {
    onSubmit = null,
    submitLabel = 'Comment',
    submitIcon = 'send',
    onStatus = null,
    /** Floor for the auto-grow, in px. A composer wants to start small and
     *  follow what you type; a description field is somewhere you sit and
     *  write, so it gets a standing area to write in. */
    minHeight = 0,
} = {}) {
    const say = (m) => { try { onStatus?.(m); } catch { /* status is advisory */ } };

    // Structure: .td-mde > [toolbar, .td-mde__row > [textarea, submit]]
    const root = document.createElement('div');
    root.className = 'td-mde';
    ta.parentNode.insertBefore(root, ta);

    const bar = document.createElement('div');
    bar.className = 'td-mde__bar';
    bar.innerHTML = TOOLBAR.map((group) => group.map((b) =>
        `<button type="button" class="td-mde__btn" data-cmd="${b.cmd}" title="${b.title}"
                 aria-label="${b.title}" tabindex="-1">${b.icon ? icon(b.icon) : `<span class="td-mde__txt">${b.text}</span>`}</button>`
    ).join('')).join('<span class="td-mde__sep"></span>');

    const row = document.createElement('div');
    row.className = 'td-mde__row';

    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.multiple = true;
    file.className = 'td-mde__file';

    root.appendChild(bar);
    root.appendChild(row);
    row.appendChild(ta);
    // The submit button sits in the ROW, to the right of the field — a
    // comment box whose button is parked underneath reads as a form, and
    // this is a chat.
    let submitBtn = null;
    if (onSubmit) {
        submitBtn = document.createElement('button');
        submitBtn.type = 'button';
        submitBtn.className = 'ea-btn ea-btn--primary td-mde__submit';
        submitBtn.innerHTML = `${icon(submitIcon)}<span>${submitLabel}</span>`;
        submitBtn.title = `${submitLabel} (Enter) — Alt+Enter for a new line`;
        row.appendChild(submitBtn);
    }
    root.appendChild(file);
    ta.classList.add('td-mde__area');

    /* auto-grow — the field starts small and follows the content */
    const grow = () => {
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(Math.max(ta.scrollHeight + 2, minHeight), 420)}px`;
    };

    /* ── commands ── */
    const COMMANDS = {
        bold:    () => wrapSelection(ta, '**', '**', 'bold'),
        italic:  () => wrapSelection(ta, '*', '*', 'italic'),
        strike:  () => wrapSelection(ta, '~~', '~~', 'struck'),
        code:    () => wrapSelection(ta, '`', '`', 'code'),
        h1:      () => prefixLines(ta, '# '),
        h2:      () => prefixLines(ta, '## '),
        h3:      () => prefixLines(ta, '### '),
        quote:   () => prefixLines(ta, '> '),
        bullet:  () => prefixLines(ta, '- '),
        ordered: () => prefixLines(ta, '', { ordered: true }),
        task:    () => prefixLines(ta, '- [ ] '),
        hr:      () => insertBlock(ta, '---'),
        table:   () => insertBlock(ta, TABLE_SKELETON, { caretOffset: 2 }),
        codeblock: () => {
            const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
            // Caret lands on the language slot when the block is empty, and
            // after the fence when it wraps an existing selection.
            insertBlock(ta, '```\n' + (sel || '') + '\n```', { caretOffset: 3 });
        },
        link: () => {
            const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
            const href = window.prompt('Link URL:', 'https://');
            if (!href) return;
            const label = sel || 'link';
            const { selectionStart: s, selectionEnd: e } = ta;
            const text = `[${label}](${href})`;
            replaceRange(ta, s, e, text, s + 1, s + 1 + label.length);
        },
        image: () => file.click(),
    };

    /* ── image insertion ── */
    let uploads = 0;
    const setBusy = (on) => {
        if (submitBtn) submitBtn.disabled = on;
        root.classList.toggle('td-mde--busy', on);
    };

    /** Upload each image and splice its markdown in at the caret. A
     *  placeholder holds the spot so the user can keep typing while the
     *  request is in flight; it is swapped for the real ref on completion
     *  and REMOVED on failure, so a dead marker never survives in the text. */
    const insertImages = async (files) => {
        const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
        if (!images.length) return;
        uploads += images.length;
        setBusy(true);
        for (const f of images) {
            const token = `![uploading ${f.name || 'image'}…]()`;
            const { selectionStart: s, selectionEnd: e } = ta;
            replaceRange(ta, s, e, token);
            grow();
            try {
                const url = await uploadImage(f);
                const ref = `![${(f.name || 'image').replace(/[[\]]/g, '')}](${url})`;
                const at = ta.value.indexOf(token);
                if (at >= 0) replaceRange(ta, at, at + token.length, ref, at + ref.length, at + ref.length);
                say(`Attached ${f.name || 'image'}.`);
            } catch (err) {
                const at = ta.value.indexOf(token);
                if (at >= 0) replaceRange(ta, at, at + token.length, '', at, at);
                say(`Image upload failed: ${err.message}`);
            } finally {
                uploads--;
            }
        }
        setBusy(uploads > 0);
        grow();
    };

    /* ── wiring ── */
    const onBarClick = (e) => {
        const btn = e.target.closest('[data-cmd]');
        if (!btn) return;
        e.preventDefault();
        COMMANDS[btn.dataset.cmd]?.();
        grow();
    };
    const onFile = () => { insertImages(file.files); file.value = ''; };

    const onKeyDown = (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && !e.altKey) {
            const k = e.key.toLowerCase();
            if (k === 'b') { e.preventDefault(); COMMANDS.bold(); return; }
            if (k === 'i') { e.preventDefault(); COMMANDS.italic(); return; }
            if (k === 'k') { e.preventDefault(); COMMANDS.link(); return; }
        }
        if (e.key !== 'Enter') return;
        // Alt+Enter (and Shift+Enter, the habit most chat apps train) is the
        // newline; plain Enter posts. Ctrl+Enter keeps posting too, so the
        // muscle memory from the old composer still lands.
        //
        // Shift+Enter can simply fall through: a textarea's OWN default for it
        // is a newline. Alt+Enter cannot — browsers give Alt+Enter no default
        // action in a textarea at all, so returning here silently ate the
        // keystroke and nothing was inserted. It has to do the insert itself.
        if (e.shiftKey) return;
        if (e.altKey) {
            e.preventDefault();
            // Via replaceRange so it lands in the native undo stack like every
            // other edit, and so its input event drives the auto-grow.
            replaceRange(ta, ta.selectionStart, ta.selectionEnd, '\n');
            return;
        }
        if (!onSubmit) return;
        e.preventDefault();
        submit();
    };

    const submit = () => {
        const text = ta.value.trim();
        if (!text || uploads > 0) return;
        onSubmit(text);
    };

    const onPaste = (e) => {
        const files = Array.from(e.clipboardData?.files || []);
        if (!files.some((f) => f.type.startsWith('image/'))) return;
        e.preventDefault();
        insertImages(files);
    };
    const onDragOver = (e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        e.preventDefault();
        root.classList.add('td-mde--drop');
    };
    const onDragLeave = () => root.classList.remove('td-mde--drop');
    const onDrop = (e) => {
        const files = Array.from(e.dataTransfer?.files || []);
        root.classList.remove('td-mde--drop');
        if (!files.some((f) => f.type.startsWith('image/'))) return;
        e.preventDefault();
        insertImages(files);
    };

    bar.addEventListener('mousedown', (e) => e.preventDefault()); // keep caret
    bar.addEventListener('click', onBarClick);
    file.addEventListener('change', onFile);
    ta.addEventListener('keydown', onKeyDown);
    ta.addEventListener('input', grow);
    ta.addEventListener('paste', onPaste);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('dragleave', onDragLeave);
    root.addEventListener('drop', onDrop);
    submitBtn?.addEventListener('click', submit);
    grow();

    return {
        textarea: ta,
        setBusy,
        destroy() {
            bar.removeEventListener('click', onBarClick);
            file.removeEventListener('change', onFile);
            ta.removeEventListener('keydown', onKeyDown);
            ta.removeEventListener('input', grow);
            ta.removeEventListener('paste', onPaste);
            root.removeEventListener('dragover', onDragOver);
            root.removeEventListener('dragleave', onDragLeave);
            root.removeEventListener('drop', onDrop);
        },
    };
}
