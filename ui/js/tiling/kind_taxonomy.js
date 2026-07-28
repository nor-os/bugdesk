/**
 * kind_taxonomy.js — canonical metadata for every content kind the user
 * can navigate to.
 *
 * One record per kind, consumed by:
 *
 *   - install.js          → top-nav buttons + active-state highlight
 *   - tile_breadcrumb.js  → breadcrumb segments
 *   - wm.js navigateBack  → Backspace parent
 *   - command_palette.js  → palette chip strip
 *
 * Adding a new kind: drop one record here and every chrome surface
 * picks it up. The three maps that used to live in install.js /
 * tile_breadcrumb.js / wm.js are gone — they kept drifting out of sync
 * (e.g. archetype_viewer existed in the page registry but in none of
 * the three, so Backspace, breadcrumb, and ARCH highlight all broke
 * on that page).
 *
 * Fields:
 *   - label       Long form, used in breadcrumb segments + palette.
 *   - shortLabel  Optional ≤4-char chip text for the top-nav.
 *                 Falls back to `label` when omitted.
 *   - icon        Material Symbols name.
 *   - topNav      Top-nav category this kind belongs to. Determines
 *                 which button lights up + which segment the
 *                 breadcrumb inserts after the project name.
 *                 Omit on the top-nav kind itself.
 *   - isTopNav    True iff this kind owns a slot in the top-nav strip.
 *   - order       Sort key for top-nav display (lower = leftward).
 *   - entityKind  For listing landings — the kind that opens when
 *                 you click a row. Unused right now; reserved.
 */

export const KIND_TAXONOMY = {
    // BugDesk taxonomy — the ONLY top-nav is Queues. `home` maps to the
    // Queues landing (WM default leaf); `ticket` is a sub-page of Queues.
    home:               { label: 'Home',      icon: 'home' },

    queues:             { label: 'Queues',    shortLabel: 'Que',  icon: 'inbox',
                          isTopNav: true, order: 20 },
    ticket:             { label: 'Bug',       icon: 'bug_report', topNav: 'queues' },

    // Settings reachable from the hamburger; no top-nav slot. App-global
    // (localStorage-backed, openable with no project loaded), so its
    // breadcrumb omits the project ancestor — `appGlobal` flags that.
    settings:         { label: 'Settings', icon: 'settings',              topNav: 'home', appGlobal: true },
};


/** Lookup helper. Returns `undefined` for unknown kinds — chrome code
 *  treats that as "render the kind name verbatim". */
export function getKindMeta(kind) {
    return KIND_TAXONOMY[kind];
}

/** Top-nav category id that owns `kind`. For a top-nav kind itself,
 *  returns the same kind. Returns `undefined` when the kind isn't in
 *  the taxonomy (caller renders a fallback). */
export function topNavFor(kind) {
    const meta = KIND_TAXONOMY[kind];
    if (!meta) return undefined;
    if (meta.isTopNav) return kind;
    return meta.topNav;
}

/** Backspace target — walk one step up the hierarchy. A top-nav page
 *  goes to Home; everything else goes to its top-nav. `home` is the
 *  root and returns `null`. */
export function parentKindFor(kind) {
    if (kind === 'home') return null;
    const meta = KIND_TAXONOMY[kind];
    if (!meta) return null;
    if (meta.isTopNav) return 'home';
    return meta.topNav || 'home';
}

/** Top-nav entries in display order. Each entry is the shape the
 *  top-nav strip + command palette need:
 *      { kind, label (short), longLabel, icon }
 *  `label` is the chip text; `longLabel` is what the palette shows. */
export function topNavEntries() {
    return Object.entries(KIND_TAXONOMY)
        .filter(([, m]) => m.isTopNav)
        .sort((a, b) => (a[1].order ?? 1000) - (b[1].order ?? 1000))
        .map(([kind, m]) => ({
            kind,
            label:     m.shortLabel || m.label,
            longLabel: m.label,
            icon:      m.icon,
        }));
}
