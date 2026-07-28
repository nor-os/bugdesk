/**
 * history_nav.js — bind the browser's Back gesture to the WM's walk-up.
 *
 * The shell is a single document: every "page" is a tile/tab mutation, so
 * the browser's session history knows nothing about where the user is.
 * Left alone, Back leaves the app entirely — losing the whole tile layout
 * — which is never what someone drilling out of a bug meant.
 *
 * So we bind Back to exactly what Backspace does (`wm.navigateBack`):
 * pop the active tab's history, else close a drilled-in tab and land on
 * the tab that opened it, else walk one step up the taxonomy. At the root
 * both do nothing — that is the same no-op Backspace performs there, not
 * a special case.
 *
 * THE SENTINEL. Back can only be observed by letting it happen, so we park
 * one throwaway history entry on top of the app's own and listen for its
 * pop. Re-arming inside the handler truncates the forward entry and
 * appends a fresh one, so session history stays exactly two deep no matter
 * how many times the user goes back — it does not grow.
 *
 * pushState is called with NO url argument on purpose: the address must
 * stay byte-identical, because ticketdesk/pages.js keys its headless
 * verification hook off `location.hash === '#ticket'`.
 *
 * This covers every Back affordance at once — the toolbar button, Alt+←,
 * the mouse's back button, and trackpad/touch swipe gestures — since they
 * all resolve to the same history traversal.
 */

const SENTINEL = 'twmBack';

/** Wire the browser's Back gesture to `wm.navigateBack()`. Returns a
 *  teardown function; the shell installs this once and never unbinds, but
 *  tests and hot-reload paths need the handle. */
export function installHistoryBack({ wm }) {
    if (!wm) return () => {};

    // Park a sentinel above the app's entry, unless one is already the
    // current entry (a reload restores history.state, so re-arming on
    // boot would stack a second one).
    const arm = () => {
        if (history.state && history.state[SENTINEL]) return;
        history.pushState({ [SENTINEL]: true }, '');
    };

    const onPopState = () => {
        // The sentinel has just been consumed. Replace it first so Back
        // stays bound for the next press even if navigateBack throws.
        arm();
        // Deliberately NOT gated on whether focus sits in a text field.
        // Backspace has to skip fields or it would eat characters; Back is
        // an explicit navigation gesture with no such double meaning.
        wm.navigateBack?.();
    };

    arm();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
}
