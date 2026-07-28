/**
 * CodeFilePane — a raw project code-file editor tab (content kind: 'code').
 *
 * Opens any non-entity project `.py` (a shared helper module like
 * `lib/economics.py`) in the same Monaco editor the agent Code tab uses. It's
 * a plain file — no entity, no AST round-trip — so it loads the raw source BY
 * PATH (`read_file_by_path`) and saves BY PATH (`code_file_save`, which
 * ast-validates `.py` before writing). Debounced autosave on change + a flush
 * on blur, matching every other editor in the app — no Save button. A thin
 * status line surfaces save results so a syntax-rejected save isn't silent.
 *
 * The tab's `id` (entityId from the file-tree route) IS the project-relative
 * file path.
 */

const _api = () => window.pywebview?.api;

export function makeCodeFilePane(host, id, ctx = {}) {
    return new _CodeFilePane(host, id, ctx);
}

class _CodeFilePane {
    constructor(host, id, ctx = {}) {
        this.host = host;
        this.path = String(id || '');
        this.logger = ctx.logger || console;
        this._editor = null;
        this._ta = null;
        this._statusEl = null;
        this._saveTimer = null;
    }

    get title() { return this.path.split('/').pop() || this.path; }

    async mount() {
        this.host.innerHTML = '';
        this.host.classList.add('ea-pane-content', 'ea-pane-content--code');
        this.host.style.display = 'flex';
        this.host.style.flexDirection = 'column';
        this.host.style.minHeight = '0';

        const editorEl = document.createElement('div');
        editorEl.style.cssText = 'flex:1 1 auto; min-height:0; position:relative;';
        const statusEl = document.createElement('div');
        statusEl.className = 'ea-code-pane__status';
        statusEl.style.cssText =
            'flex:0 0 auto; padding:2px 10px; min-height:18px;'
            + 'font:11px/18px var(--font-mono, ui-monospace, monospace);'
            + 'color:var(--text-dim, #888);'
            + 'border-top:1px solid var(--border, #2a2a2a);';
        this._statusEl = statusEl;
        this.host.appendChild(editorEl);
        this.host.appendChild(statusEl);

        let source = '';
        try {
            source = (await _api()?.read_file_by_path?.(this.path)) || '';
        } catch (err) {
            this._setStatus('could not read file: ' + (err?.message || err), true);
            this.logger.warn?.('code_file read failed', { path: this.path, err });
        }

        let factory = null;
        try {
            const mod = await import('../../notebook/monaco_editor_factory.js');
            factory = await mod.getEditorFactory();
        } catch (err) {
            this.logger.warn?.('Monaco unavailable; using textarea fallback', { err });
        }

        if (!factory) {
            const ta = document.createElement('textarea');
            ta.className = 'ea-code-editor';
            ta.value = source;
            ta.spellcheck = false;
            ta.style.cssText =
                'width:100%; height:100%; box-sizing:border-box; border:0;'
                + 'resize:none; outline:none; padding:8px;'
                + 'font:13px/1.5 var(--font-mono, ui-monospace, monospace);';
            editorEl.appendChild(ta);
            this._ta = ta;
            ta.addEventListener('input', () => this._scheduleSave(ta.value));
            return;
        }

        const handle = factory.createEditor(editorEl, source, {
            language: 'python',
            noAutoHeight: true,
            automaticLayout: true,
            minimap: { enabled: false },
            scrollbar: { alwaysConsumeMouseWheel: false },
        });
        this._editor = handle;
        handle.onDidChange(() => this._scheduleSave(handle.getValue()));
        try {
            handle.editor?.onDidBlurEditorWidget?.(() => {
                clearTimeout(this._saveTimer);
                this._save(handle.getValue());
            });
        } catch { /* older Monaco — the debounced save still covers it */ }
    }

    _setStatus(msg, isError = false) {
        if (!this._statusEl) return;
        this._statusEl.textContent = msg || '';
        this._statusEl.style.color = isError
            ? 'var(--danger, #e06c75)'
            : 'var(--text-dim, #888)';
    }

    _scheduleSave(src) {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._save(src), 700);
    }

    async _save(src) {
        try {
            const res = await _api()?.code_file_save?.(this.path, src);
            if (res && res.ok === false) {
                this._setStatus(res.error || 'save failed', true);
            } else {
                this._setStatus('Saved', false);
            }
        } catch (err) {
            this._setStatus('save failed: ' + (err?.message || err), true);
            this.logger.warn?.('code_file save failed', { path: this.path, err });
        }
    }

    destroy() {
        clearTimeout(this._saveTimer);
        try { this._editor?.dispose?.(); } catch { /* noop */ }
        this._editor = null;
        this._ta = null;
    }
}
