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
 * `bugdesk.humanName` / `bugdesk.agentName` are BugDesk's own addition: the
 * editable form of WHO YOU ARE (see README.md's "Who you are" and
 * "Authorship" sections). Both default to `''` ("use whatever the server
 * resolved"). They live under the shell's own `general` category
 * (@flexdesk/core's CATEGORIES already has one, order 10 — "Workspace
 * behavior and notifications" fits an identity setting fine) rather than a
 * new bugdesk-only category, since there's exactly one group ("Authorship")
 * of settings here — not enough to earn its own sidebar entry the way
 * `ecoagent` used to.
 *
 * These are NOT browser-only overrides any more, and they are no longer the
 * authority either. Since the per-user profile landed (server/UserConfig.cs),
 * THE PROFILE ON DISK is the source of truth for who you are: it is what the
 * first-run gate and "Change your name" write, and what `GET /api/config`
 * reports to the /bugs, /backlog and /tracker skills. These two rows are an
 * editor for it, not a second copy of it —
 * `first_run.js`'s `installAuthorshipWriteThrough` mirrors every change here
 * into the profile, and `ticketdesk/data.js` reads the profile FIRST, falling
 * back to the stored value only when no bridge answered.
 *
 * The precedence used to run the other way, and there was no floor to it: the
 * stored value is browser-local and permanent, so once anyone had typed a name
 * here, every later change made anywhere else wrote the profile, updated the
 * bridge, updated the skills — and the UI went on signing comments with the
 * stale local value through every reload, with nothing reporting a problem.
 *
 * Changing the name therefore SWITCHES PROFILE (creating one if the name is
 * new) rather than renaming you in place. That is the honest reading in a
 * repo several people share: the field selects an identity, and identities
 * own their own filters.
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

/**
 * The settings BugDesk actually honours.
 *
 * `@flexdesk/core` registers a schema written for a different application — a
 * simulation IDE with ETL pipelines, an AI assistant, an autosaving editor and a
 * projects directory. BugDesk inherits the whole of it and READS almost none of
 * it, so the Settings page advertised a page and a half of controls that change
 * nothing: an Auto-Save section over a store that has no autosave, an ETL group,
 * an AI category. A setting nobody reads is not a harmless leftover — it is the
 * app promising something it does not do, and the user has no way to tell which
 * of the rows in front of them are real.
 *
 * So this is an ALLOW-LIST, and `scripts/test-dom.mjs` keeps it honest: every
 * path here must be read somewhere in `ui/js` or the vendored FlexDesk (or be
 * an `action` row, which is a button rather than a value), and every path read
 * in `ui/js` must be listed here. Add a setting to the app and the test tells
 * you to list it; delete the code that reads one and the test tells you the
 * row is now a lie.
 */
export const VISIBLE_SETTINGS = new Set([
    // Who you are, and what a Ctrl-click does — BugDesk's own.
    'bugdesk.humanName',
    'bugdesk.agentName',
    'bugdesk.collaborators',
    'bugdesk.recordTypes',
    'bugdesk.workflow',
    'bugdesk.flows',
    'bugdesk.numbering',
    'bugdesk.git',
    'bugdesk.alerts',
    'bugdesk.modifierOpen',
    // Read by FlexDesk's managed windows, which BugDesk's floats are.
    'window.animateMinimize',
]);

/**
 * Read by live code, and still not worth offering.
 *
 * The bar for a settings row is not "some code branches on it" — it is "the
 * user can observe the difference". `modules.autoCreateDefaults` is read on
 * boot by `utils/module_loader.js`, which looks for an EcoSim modules directory
 * that a bug tracker does not have and quietly finds nothing. Its row read
 * "Auto-create default modules — create the default Economy module", which is
 * a sentence about another program.
 *
 * Listed rather than silently dropped so the drift guard in
 * `scripts/test-dom.mjs` stays total: every setting the app reads must be
 * either offered or named here, with the reason.
 */
export const HIDDEN_SETTINGS = new Set([
    'modules.autoCreateDefaults',
]);

// ─── bugdesk-owned settings slice ────────────────────────────────────────────
// Pushed into the shell-global store by app_bootstrap.js via
// `registerSettings(BUGDESK_SETTINGS_SLICE)`. Kept here (not in
// app_bootstrap.js itself) so the defaults/schema/category triple lives
// next to the settings documentation above, matching where this data used
// to live before the extraction.
export const BUGDESK_SETTINGS_SLICE = {
    // Flows get a sidebar entry of their own (STORY-0028): they are managed
    // apart from the move tables that use them. Right under General.
    categories: [
        { id: 'flows', label: 'Flows', icon: 'account_tree',
          description: 'Reusable flows for moves and actions', order: 15 },
    ],

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
            // What Ctrl/Cmd-click on a list row does. See ticketdesk/record_dnd.js.
            modifierOpen: 'tab',
            // Not a stored value — the row is a button (see the schema below).
            // It carries a default so the settings store has a shape for the
            // path and the row renders like every other one.
            collaborators: null,
            recordTypes: null,
            workflow: null,
            flows: null,
            numbering: null,
            git: null,
            alerts: null,
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
            description: 'The name shown as assignee and comment author on everything you file. Saved to your per-user profile beside the store, so it follows you rather than this browser. Entering a different name switches to that person\'s profile (creating it if it is new), along with their saved filters. Leave blank to use the server\'s BUGDESK_HUMAN default. Takes effect after a reload.',
            defaultValue: '', placeholder: '(server default)', reloadHint: true,
        },
        // A roster is a list of records, and no scalar control can edit one —
        // so this row is a button that opens the editor that owns it. See
        // settings_page.js's `type: 'action'`.
        'bugdesk.collaborators': {
            type: 'action', category: 'general', group: 'Authorship',
            label: 'Collaborators',
            description: 'Everyone who can be assigned work on this repo, from the shared bugdesk.json beside the stores. Setting your name adds you automatically; edit the list here to add someone who has not opened it yet, or to remove someone who has left.',
            buttonLabel: 'Manage collaborators…',
            icon: 'group',
            defaultValue: null,
            onClick: async () => {
                const { openCollaborators } = await import('../ticketdesk/collaborators.js');
                return openCollaborators({ eventBus: window.__ecoagent?.eventBus });
            },
        },

        // Custom fields, hidden built-ins and custom statuses per record type —
        // a schema, edited in its own window like the roster above.
        'bugdesk.recordTypes': {
            type: 'action', category: 'general', group: 'Project',
            label: 'Record types',
            description: 'Your own fields (text, number, date, yes/no, choice) and statuses per record type, and which optional built-in fields each type shows. Saved in the shared project.json beside the stores, so everyone who pulls the repo gets the same ones.',
            buttonLabel: 'Edit record types…',
            icon: 'schema',
            defaultValue: null,
            onClick: async () => {
                const { openSchemaEditor } = await import('../ticketdesk/schema_editor.js');
                return openSchemaEditor({ eventBus: window.__ecoagent?.eventBus });
            },
        },

        // The moves, what they do on the side, and the custom actions.
        'bugdesk.workflow': {
            type: 'action', category: 'general', group: 'Project',
            label: 'Workflow',
            description: 'Which moves each status offers, what they are called, which need a message, and which flow a move runs on the side (clear the assignee, ask a question, add a comment) — per record type. The flows themselves are under Flows. Saved in the shared project.json beside the stores. With nothing set, records move the built-in way.',
            buttonLabel: 'Edit workflow…',
            icon: 'account_tree',
            defaultValue: null,
            onClick: async () => {
                const { openWorkflowEditor } = await import('../ticketdesk/workflow_editor.js');
                return openWorkflowEditor({ eventBus: window.__ecoagent?.eventBus });
            },
        },

        // The named flows the moves and actions use (STORY-0028).
        'bugdesk.flows': {
            type: 'panel', category: 'flows', group: 'Flows',
            label: 'Flows',
            description: 'What a move or a custom action does on the side — ask a question, set or clear a field, add a comment, check a field and branch — as named flows, shared by every move and action that picks them in Edit workflow. Saved in the shared project.json beside the stores.',
            buttonLabel: 'Go to Flows',
            icon: 'account_tree',
            defaultValue: null,
            // Drawn on the Settings page itself, not in a window (settings_page.js's `type: 'panel'`).
            mount: async (el, { eventBus } = {}) => {
                const { mountFlowsManager } = await import('../ticketdesk/flows_editor.js');
                return mountFlowsManager(el, { eventBus: eventBus || window.__ecoagent?.eventBus });
            },
        },

        // How new records are named and numbered.
        'bugdesk.numbering': {
            type: 'action', category: 'general', group: 'Project',
            label: 'Numbering',
            description: 'The prefix new records are named with (BUG, EPIC, STORY, …), how far their numbers are zero-padded, the first number and the increment. Existing records keep their names, and references to them keep working. Saved in the shared project.json.',
            buttonLabel: 'Edit numbering…',
            icon: 'pin',
            defaultValue: null,
            onClick: async () => {
                const { openNumberingEditor } = await import('../ticketdesk/numbering_editor.js');
                return openNumberingEditor({ eventBus: window.__ecoagent?.eventBus });
            },
        },

        // Commit after save, push after commit — the Changes pane's two switches.
        'bugdesk.git': {
            type: 'action', category: 'general', group: 'Project',
            label: 'Saving and git',
            description: 'Whether each save commits the record it wrote, and whether that commit is pushed. Off by default. The bottom panel\'s Changes tab lists what is uncommitted, with its diff, and commits and pushes by hand.',
            buttonLabel: 'Saving and git…',
            icon: 'commit',
            defaultValue: null,
            onClick: async () => {
                const { openGitSettings } = await import('../ticketdesk/changes_pane.js');
                return openGitSettings({ eventBus: window.__ecoagent?.eventBus });
            },
        },

        // Alert rules: a condition, a level, and how it is shown.
        'bugdesk.alerts': {
            type: 'action', category: 'general', group: 'Project',
            label: 'Alerts',
            description: 'Rules that raise an alert when a record starts matching a condition — any filter, custom fields included — as info, a warning or an alert, in the bottom panel and optionally as a toast. Alerts only fire while BugDesk is open; changes made while it was closed are not reported.',
            buttonLabel: 'Edit alerts…',
            icon: 'notifications',
            defaultValue: null,
            onClick: async () => {
                const { openAlertsEditor } = await import('../ticketdesk/alerts.js');
                return openAlertsEditor({ eventBus: window.__ecoagent?.eventBus });
            },
        },

        // Both answers are reasonable and the difference is about how someone
        // works, not about which is correct — so it is a setting rather than a
        // decision made for everybody.
        'bugdesk.modifierOpen': {
            type: 'select', category: 'general', group: 'Records',
            label: 'Ctrl-click a record',
            description: 'What Ctrl-click or Ctrl+Enter (Cmd on a Mac) does to a row in the bug queue, '
                + 'the backlog, search results or the Tracker dashboard. Either way the list you are reading '
                + 'stays in front of you — that is the point of the gesture. Alt+T and Alt+N open a row in a '
                + 'new tab or a floating window whatever this says, and you can DRAG a row onto any tile.',
            options: [
                { value: 'tab', label: 'Open in a background tab' },
                { value: 'window', label: 'Open in a floating window' },
            ],
            defaultValue: 'tab',
        },

        'bugdesk.agentName': {
            type: 'text', category: 'general', group: 'Authorship',
            label: 'Agent name',
            description: 'The name your AI assistant signs its comments with. Left blank it is derived from your own name as <you>_agent, which is what keeps two people\'s assistants from signing identically. Takes effect after a reload.',
            defaultValue: '', placeholder: '(server default)', reloadHint: true,
        },
    },
};
