/**
 * Application Settings (bugdesk) — thin binding over @flexdesk/core's
 * shell-owned settings store, plus bugdesk's own surviving namespace.
 *
 * @flexdesk/core's own DEFAULTS/SCHEMA/CATEGORIES already match what this
 * file used to hand-roll for every namespace EXCEPT `modules` — that's
 * bugdesk/EcoAgent vocabulary the library must not bake in (see FlexDesk's
 * core/settings.js doc comment: "the shell ships its own namespaces... an
 * embedder PUSHES its own namespace in at boot").
 *
 * `simulation.runRetention` (an EcoSim-era namespace this file used to
 * carry) was dropped outright rather than migrated: a repo-wide grep
 * turned up no `getSetting('simulation...')` / `setSetting('simulation...')`
 * reads anywhere in the surviving `ui/js/**` tree, so it was dead config
 * left over from the ODE-simulation run-history feature that never shipped
 * in bugdesk.
 *
 * The `ecoagent.*` namespace (run/population/eventLog settings) was
 * dropped the same way in a later pass: its only readers were
 * `ui/js/ecoagent/bottom_panel.js` and `ui/js/ecoagent/event_log_store.js`
 * (both deleted as dead code — permanently shadowed content-registry
 * entries, see ui/js/tiling/page_stubs.js's doc comment) and
 * `runtime_controls.js` (deleted earlier in the same cleanup). A repo-wide
 * grep for `ecoagent.run.` / `ecoagent.population.` / `ecoagent.eventLog.`
 * came back empty once those three were gone, so the namespace — schema,
 * defaults, and the `ecoagent` settings category — was removed outright
 * rather than carried forward for no reader.
 *
 * `modules.autoCreateDefaults` IS still read by surviving code
 * (ui/js/utils/module_loader.js) — that file is out of scope for this
 * migration, so instead of deleting the namespace this file exports
 * BUGDESK_SETTINGS_SLICE for app_bootstrap.js to push in via
 * `registerSettings()` at the very top of bootstrap, before any
 * getSetting/setSetting call (registration order matters — see
 * `registerSettings`'s doc comment).
 *
 * `bugdesk.humanName` / `bugdesk.agentName` are BugDesk's own addition: a
 * per-browser override of the server's `BUGDESK_HUMAN` / `BUGDESK_AGENT`
 * author names (see README.md's "Authorship" section). Both default to
 * `''` ("use the server default"). They live under the shell's own
 * `general` category (@flexdesk/core's CATEGORIES already has one, order
 * 10 — "Workspace behavior and notifications" fits an identity setting
 * fine) rather than a new bugdesk-only category, since there's exactly
 * one group ("Authorship") of settings here — not enough to earn its own
 * sidebar entry the way `ecoagent` used to.
 *
 * `ui/js/ticketdesk/data.js` reads both once, at module-evaluation time
 * (same "resolve once at load" design as its `HUMAN_AUTHOR`/`AGENT_AUTHOR`
 * constants already had for `window.__BUGDESK_CONFIG__` — see that file's
 * doc comment), so a change here needs a reload to take effect. Both
 * schema entries carry `reloadHint: true`; `ui/js/ui/pages/settings_page.js`
 * reads that flag generically (not hardcoded to these two paths) and
 * surfaces a one-line toast via the existing `toast:show` event bus
 * convention already used everywhere else in this codebase for
 * "something async just happened" feedback.
 *
 * Every OTHER consumer in this codebase keeps importing
 * `getSetting`/`setSetting`/etc. from this same path ('../core/settings.js')
 * exactly as before — only this file's internals changed.
 */

export {
    getSetting,
    setSetting,
    getDefaultValue,
    resetSetting,
    resetCategory,
    resetAllSettings,
    getAllSettings,
    getSchema,
    getCategories,
    getSettingsByCategory,
    registerSettingsEventBus,
    registerSettings,
} from '@flexdesk/core';

// ─── bugdesk-owned settings slice ────────────────────────────────────────────
// Pushed into the shell-global store by app_bootstrap.js via
// `registerSettings(BUGDESK_SETTINGS_SLICE)`. Kept here (not in
// app_bootstrap.js itself) so the defaults/schema/category triple lives
// next to the settings documentation above, matching where this data used
// to live before the extraction.
export const BUGDESK_SETTINGS_SLICE = {
    defaults: {
        // Only auto-create-defaults survives; the modules directory / addon /
        // ETL-plugin loaders were EcoSim's node-graph plugin system.
        modules: {
            autoCreateDefaults: true,
        },

        // '' on both means "use the server's BUGDESK_HUMAN / BUGDESK_AGENT
        // default" — see ticketdesk/data.js's HUMAN_AUTHOR/AGENT_AUTHOR
        // resolution.
        bugdesk: {
            humanName: '',
            agentName: '',
        },
    },

    schema: {
        'modules.autoCreateDefaults': {
            type: 'boolean', category: 'advanced', group: 'Modules',
            label: 'Auto-create default modules',
            description: 'Create the default Economy module if it does not exist in the modules directory.',
            defaultValue: true,
        },

        'bugdesk.humanName': {
            type: 'text', category: 'general', group: 'Authorship',
            label: 'Your name',
            description: 'Overrides the server\'s default human author for comments and bugs you create — the name shown as assignee and comment author. Leave blank to use the server\'s BUGDESK_HUMAN default. Takes effect after you reload BugDesk.',
            defaultValue: '', placeholder: '(server default)', reloadHint: true,
        },
        'bugdesk.agentName': {
            type: 'text', category: 'general', group: 'Authorship',
            label: 'Agent name',
            description: 'Overrides the server\'s default agent author. Less likely to need changing per browser than "Your name", but kept configurable for consistency. Leave blank to use the server\'s BUGDESK_AGENT default. Takes effect after you reload BugDesk.',
            defaultValue: '', placeholder: '(server default)', reloadHint: true,
        },
    },
};
