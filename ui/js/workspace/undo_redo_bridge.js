// Wires the app-level Undo/Redo (Ctrl+Z / Ctrl+Y / Shift+Ctrl+Z + Edit menu)
// to the backend file-journal in ecoagent/bridge/api.py (history_undo / redo /
// state). This replaces the dead node-graph HistoryService on the *global*
// undo path — HistoryService stays only for the AI-chat's batch undo, which
// drives it directly. See docs/UNDO_REDO_CONCEPT.md (P2).
//
// Mechanism: undo/redo restore file bytes on disk and rebuild the bridge's
// derived stores, so the UI just needs the same refresh a save already does —
// emit `ecoagent:project:changed`. The Edit-menu enable state rides on
// `history:state` (application_shell._wireHistoryEvents).

export function installUndoRedoBridge({ eventBus, logger = null } = {}) {
    const api = () => window.pywebview?.api;

    async function refreshState() {
        try {
            const st = await api()?.history_state?.();
            eventBus?.emit?.('history:state', {
                canUndo: !!st?.canUndo,
                canRedo: !!st?.canRedo,
            });
        } catch (err) {
            logger?.warn?.('history_state failed', err);
        }
    }

    async function apply(dir) {
        // No flush needed here: editors commit their debounced save on blur, and
        // Ctrl+Z only reaches this path when focus is OUTSIDE an editor — so by
        // then any pending autosave has already landed (see *_tab flush-on-blur).
        try {
            const res = await api()?.[dir === 'redo' ? 'history_redo' : 'history_undo']?.();
            if (res && res.ok === false) {
                // ok:false is a real refusal (e.g. a file changed on disk since
                // this step, or the reload failed) — an empty stack returns
                // ok:true. Surface the reason rather than swallowing it.
                eventBus?.emit?.('toast:show', {
                    title: dir === 'redo' ? "Couldn't redo" : "Couldn't undo",
                    message: res.error || 'History unavailable',
                    severity: 'warning',
                    durationMs: 4000,
                });
            } else {
                // Same refresh forms/tabs already use after a save.
                eventBus?.emit?.('ecoagent:project:changed', { source: `history-${dir}` });
            }
        } catch (err) {
            logger?.error?.('history apply failed', err);
        }
        await refreshState();
    }

    // Serialize: each apply restores files + rebuilds the project on the backend.
    // Rapid Ctrl+Z (or undo-then-redo) would otherwise overlap and race on the
    // shared undo/redo stacks + reload. Chain so one finishes before the next.
    let queue = Promise.resolve();
    const enqueue = (dir) => {
        const next = queue.catch(() => {}).then(() => apply(dir));
        queue = next;
        return next;
    };

    // Drive undo/redo through the bus, not a returned handle: the Ctrl+Z handler
    // and the Edit-menu action handler live in different lexical scopes, so a
    // shared closure can't reach both — the bus can. These names are distinct
    // from HistoryService's `history:undo:request`/`redo:request` so the dormant
    // node-graph service (kept for the AI chat) doesn't also fire.
    eventBus?.on?.('ecoagent:history:undo', () => enqueue('undo'));
    eventBus?.on?.('ecoagent:history:redo', () => enqueue('redo'));

    // Re-poll the enable state on the two reliable signals:
    //  • a project change (landing edits, undo/redo itself) — covers most cases;
    //  • a top menu opening — the just-in-time backstop for mutations that don't
    //    emit project:changed (e.g. the agent editor's param autosave).
    // refreshState is idempotent, so overlapping triggers are harmless.
    eventBus?.on?.('ecoagent:project:changed', refreshState);
    eventBus?.on?.('menu:opened', refreshState);
    refreshState();

    return { undo: () => enqueue('undo'), redo: () => enqueue('redo'), refreshState };
}
