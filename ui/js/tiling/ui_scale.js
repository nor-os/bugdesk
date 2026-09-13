/**
 * ui_scale.js — the bottom bar's zoom control, and the one place that knows
 * what "scale the UI" means here.
 *
 * The ask was for the control Tables puts in its status bar. That one is NOT a
 * FlexDesk feature — Tables built it (`web/js/grid/zoom.js` plus a strip in its
 * own status bar) and it zooms one grid. FlexDesk ships no UI-scale API at all,
 * so this is BugDesk's, written to feel like the same control: − / track / + /
 * a readout that resets, Excel's split where the track is continuous and the
 * buttons move in tens.
 *
 * WHAT IT SCALES, AND THE TWO THINGS IT DELIBERATELY DOES NOT.
 *
 * It writes CSS `zoom` on `.twm-host` — every tile, every page, both stores —
 * and on `.twm-window-content`, so a page floated into a window reads at the
 * same size as the same page in a tile.
 *
 *   1. NOT the top and bottom bars. They are chrome, they are 35 and 20 pixels
 *      tall by a constant FlexDesk also uses for maximise bounds, and a zoom
 *      that moved them would push the control off its own bar at 200%.
 *   2. NOT the floating window FRAME, only its content. ManagedWindows mount
 *      into `document.body`, outside `.twm-host`, and that is load-bearing
 *      rather than incidental: `zoom` establishes a scaled coordinate space, so
 *      a zoomed frame would put every drag, resize and aero-snap edge probe in
 *      units that no longer match the pointer. Scaling the content leaves that
 *      geometry in real pixels.
 *
 * `zoom` rather than a transform, for the reason Tables gives: it reflows, so
 * text stays on the pixel grid and scrollbars still measure the thing they are
 * scrolling. `transform: scale()` would blur it and leave the layout box behind.
 */

/** The range. Below 50% the row text stops being readable, which is why the
 *  floor is where it is rather than at a rounder number; above 200% a queue row
 *  no longer fits its own columns. */
export const SCALE_MIN = 50;
export const SCALE_MAX = 200;

/** The track's granularity — fine, because a control you have to aim is one
 *  people stop using. */
export const SCALE_STEP = 5;

/** The BUTTONS' step. Excel's own split: the track is continuous and the − / +
 *  either side of it cover ground, because a button pressed repeatedly wants to
 *  get somewhere and the readout says where you landed. */
export const SCALE_NUDGE = 10;

/**
 * The scale the app opens at, and the one a reset goes back to.
 *
 * Load-bearing, not just a number: `apply` writes the EMPTY STRING rather than
 * `zoom: 1` at this value, so an unzoomed BugDesk carries no `zoom` declaration
 * at all and lays out byte-for-byte as it did before this existed. That is only
 * true while "unzoomed" and "the default" are the same number.
 */
export const SCALE_DEFAULT = 100;

/** Where the preference lives. A per-person setting about a shared store, so it
 *  goes in the user's profile rather than localStorage — same reasoning as the
 *  backlog's fold state, and for the same reason: BugDesk is run from wherever
 *  the repo is checked out, and a zoom that does not survive moving machines is
 *  one you set again every morning. */
const SCALE_KEY = 'ui.scale';

/** A number from anywhere — a slider, a stored preference, a caller — as a
 *  scale this app will accept. Quantising is what makes 100% reachable: the
 *  track is stepped, so a stored 97 must land on a notch rather than sitting
 *  between two of them where neither button can leave. */
export function clampScale(value) {
    // `null` and `''` are checked BEFORE the cast, because Number() turns both
    // into 0 — a perfectly finite number that would then clamp to the floor.
    // "No value" has to read as the default, or a profile with no saved scale,
    // or a settings read that failed, silently opens the app at 50%.
    if (value == null || value === '') return SCALE_DEFAULT;
    const n = Number(value);
    if (!Number.isFinite(n)) return SCALE_DEFAULT;
    const stepped = Math.round(n / SCALE_STEP) * SCALE_STEP;
    return Math.min(SCALE_MAX, Math.max(SCALE_MIN, stepped));
}

/**
 * Paint one scale onto the document.
 *
 * ONE CSS VARIABLE AND ONE CLASS, not inline styles on each target. Windows are
 * created and destroyed long after any given zoom change, so anything written
 * element-by-element would have to be re-applied on every window open; a
 * variable on the root is read by whatever exists at the time.
 *
 * The class is what keeps the default free of any declaration at all. A rule
 * that always said `zoom: var(--td-ui-scale, 1)` would establish a scaled
 * coordinate space even at 1 — which is exactly the thing this module avoids
 * around the window frames — so at 100% the class comes off and no `zoom`
 * applies anywhere. Idempotent, and safe before `.twm-host` exists: it writes
 * the root, not the target.
 */
export function applyScale(percent) {
    document.documentElement.style.setProperty('--td-ui-scale', String(percent / 100));
    document.documentElement.classList.toggle('td-scaled', percent !== SCALE_DEFAULT);
}

/**
 * Build the control, mount it in the bottom bar, and restore the saved scale.
 *
 * Returns nothing: the control owns its own state from here, and there is
 * exactly one of it.
 */
export function installUiScale({ eventBus } = {}) {
    const host = document.querySelector('#global-bottom-bar .bar-right')
              ?? document.querySelector('.global-bottom-bar .bar-right')
              ?? document.querySelector('.global-bottom-bar');
    if (!host || host.querySelector('#twm-ui-scale')) return;

    let current = SCALE_DEFAULT;

    const el = document.createElement('div');
    el.id = 'twm-ui-scale';
    el.className = 'twm-ui-scale';

    const stepButton = (label, title, delta) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'twm-ui-scale__step';
        b.textContent = label;
        b.title = title;
        b.setAttribute('aria-label', title);
        b.addEventListener('click', () => {
            const next = clampScale(current + delta);
            if (next !== current) commit(next);
        });
        return b;
    };

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'twm-ui-scale__slider';
    slider.min = String(SCALE_MIN);
    slider.max = String(SCALE_MAX);
    slider.step = String(SCALE_STEP);
    slider.value = String(SCALE_DEFAULT);
    slider.title = `Scale the pages, ${SCALE_MIN}–${SCALE_MAX}% — double-click to reset.`;
    slider.setAttribute('aria-label', 'Scale the pages');
    // `input`, not `change`: the readout has to follow the thumb while it is
    // being dragged, or the number under the mouse is the number you left.
    slider.addEventListener('input', () => commit(clampScale(slider.value)));
    // A double-click on the track resets. It is preceded by two mousedowns that
    // each set the value and fire `input`, so the honest description is "one
    // real write, then the reset" and a brief jump to wherever you clicked is
    // visible before it snaps back. That is what Excel's track does, and it must
    // not be "fixed" by swallowing `input` — that is the event the drag is
    // made of.
    slider.addEventListener('dblclick', () => commit(SCALE_DEFAULT));

    // The readout IS the reset, where Excel puts it and where a hand already is.
    // A separate "100%" button would be a fourth control in a strip 20px tall,
    // and a percentage nobody can click answers the question while refusing the
    // obvious next request.
    const readout = document.createElement('button');
    readout.type = 'button';
    readout.className = 'twm-ui-scale__value';
    readout.title = `Back to ${SCALE_DEFAULT}%`;
    readout.addEventListener('click', () => commit(SCALE_DEFAULT));

    el.append(
        stepButton('−', `Zoom out ${SCALE_NUDGE}%`, -SCALE_NUDGE),
        slider,
        stepButton('+', `Zoom in ${SCALE_NUDGE}%`, SCALE_NUDGE),
        readout,
    );
    host.appendChild(el);

    /** Paint without saving. Used by the initial restore, where writing back
     *  what we just read would be a pointless round trip. */
    const paint = (percent) => {
        current = percent;
        slider.value = String(percent);
        readout.textContent = `${percent}%`;
        applyScale(percent);
    };

    /** Paint AND remember. Debounced, because a slider drag fires `input` per
     *  pixel and each one would otherwise be a POST. */
    let saveTimer = 0;
    const commit = (percent) => {
        if (percent === current) return;
        paint(percent);
        eventBus?.emit?.('bugdesk:ui-scale-changed', { scale: percent });
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            fetch('/api/user/settings', {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ [SCALE_KEY]: percent }),
            }).catch((err) => console.warn('[bugdesk] could not save the UI scale', err));
        }, 400);
    };

    paint(SCALE_DEFAULT);

    // Restored after the control is already on screen and usable. A scale is not
    // worth blocking the first paint on, and a failed read costs the default.
    fetch('/api/user/settings', { headers: { accept: 'application/json' } })
        .then((res) => (res.ok ? res.json() : null))
        .then((j) => {
            const saved = j?.settings?.[SCALE_KEY];
            if (saved != null) paint(clampScale(saved));
        })
        .catch((err) => console.warn('[bugdesk] could not read the UI scale', err));
}
