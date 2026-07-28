/**
 * tab_window_host.js — host a workspace-tab provider inside a
 * ManagedWindow, with a "Dock as tab" button to send it back.
 *
 * A "view" is identified by `{kind, entityId}` and can live in either
 * place. Both hosts mount the same provider factory; the provider
 * fetches its data from the bridge, so we never DOM-move content
 * across hosts — we dispose and remount. Trade-off: ephemeral UI state
 * (scroll position, expanded sections, Monaco caret) is lost on
 * pop-out / dock. That's fine; persistent state lives in the project.
 *
 * Window id pattern: `tab-window:<kind>[:<entityId>]`. Stable per
 * (kind, entityId) so a second pop-out focuses the existing window.
 */

import { ManagedWindow } from '../ui/components/managed_window.js';


const WINDOW_PREFIX = 'tab-window:';

function _windowId(kind, entityId) {
    return entityId == null ? `${WINDOW_PREFIX}${kind}` : `${WINDOW_PREFIX}${kind}:${entityId}`;
}


/**
 * Open a workspace-tab provider in a free-floating window. If a window
 * for this `(kind, entityId)` is already open, focus it instead of
 * creating a duplicate.
 */
export function openTabAsWindow({
    kind, entityId = null, label, icon, workspaceTabs,
    eventBus = null, logger = null,
} = {}) {
    if (!kind || !workspaceTabs) return null;
    const factory = workspaceTabs.getProvider?.(kind);
    if (typeof factory !== 'function') {
        logger?.warn?.('openTabAsWindow: no provider for kind', kind);
        return null;
    }

    const winId = _windowId(kind, entityId);
    const existing = ManagedWindow.get?.(winId);
    if (existing) { existing.show(); return existing; }

    // Build the content host the provider mounts into. Match the tab
    // host's box model so providers that compute fill-the-container
    // layouts work identically.
    const host = document.createElement('div');
    host.className = 'ea-tab-content ea-tab-content--in-window';
    host.style.height = '100%';
    host.style.minHeight = '0';

    let provider = null;
    let disposed = false;
    const runHandlers = {};
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        // Drop run-event subscriptions so a long-lived popped-out window
        // doesn't leak handlers after close.
        for (const [name, fn] of Object.entries(runHandlers)) {
            try { eventBus?.off?.(name, fn); } catch { /* ignore */ }
        }
        try { provider?.dispose?.(); } catch { /* ignore */ }
        provider = null;
    };

    const win = new ManagedWindow({
        id:            winId,
        title:         (label || '').trim() || kind,
        icon:          icon || 'tab',
        content:       host,
        minWidth:      560,
        minHeight:     380,
        defaultWidth:  900,
        defaultHeight: 600,
        modal:         false,
        actions: [{
            icon:  'splitscreen',
            title: 'Dock as tab',
            onClick: () => {
                // Close first so the provider's `dispose` runs before
                // a fresh instance mounts in the new tab.
                try { win.close(); } catch { /* ignore */ }
                workspaceTabs.openTab({ kind, entityId, label, icon });
            },
        }],
        onClose: () => { dispose(); },
    });

    win.show();
    try {
        provider = factory(host, entityId, {
            eventBus, logger, workspaceTabs,
        });
    } catch (err) {
        logger?.error?.('tab-as-window: provider factory threw', { kind, err });
        try { win.close(); } catch { /* ignore */ }
        return null;
    }
    Promise.resolve()
        .then(() => provider?.mount?.())
        .then(() => provider?.show?.())
        .then(() => {
            // Subscribe to the same run-lifecycle events workspaceTabs
            // dispatches to its tabs so the popped-out window keeps its
            // data live across ticks / project switches.
            if (!eventBus?.on) return;
            const onRefresh = () => {
                try { provider?.refresh?.(); }
                catch (err) { logger?.warn?.('tab-as-window: refresh failed', { kind, err }); }
            };
            runHandlers['ecoagent:run:started']     = onRefresh;
            runHandlers['ecoagent:run:tick']        = onRefresh;
            runHandlers['ecoagent:run:completed']   = onRefresh;
            runHandlers['ecoagent:project:changed'] = onRefresh;
            for (const [name, fn] of Object.entries(runHandlers)) eventBus.on(name, fn);
        })
        .catch((err) => logger?.warn?.('tab-as-window: mount failed', { kind, err }));

    return win;
}


/** Lookup for an existing pop-out window — useful when the user is
 *  about to open or close the matching tab and we want to know whether
 *  a parallel window exists. */
export function findTabWindow(kind, entityId = null) {
    return ManagedWindow.get?.(_windowId(kind, entityId)) || null;
}
