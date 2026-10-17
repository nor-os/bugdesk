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
 * resolved"). They live on Settings › Profile, under "You" — see
 * BUGDESK_SETTINGS_SLICE below for how the sidebar is sorted.
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
    // You: who you are, and how BugDesk behaves for you — BugDesk's own.
    'bugdesk.humanName',
    'bugdesk.agentName',
    'bugdesk.modifierOpen',
    'bugdesk.autosave',
    'bugdesk.tracker',
    // This project: shared with everyone who pulls the repo.
    'bugdesk.recordTypes',
    'bugdesk.workflow',
    'bugdesk.collaborators',
    'bugdesk.alerts',
    'bugdesk.git',
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
/**
 * The page's event bus, for the editors Settings opens. install.js publishes it
 * as `window.__bugdesk.eventBus` because these callbacks are defined before the
 * shell exists. They used to read `window.__ecoagent`, a name left over from
 * the app this shell came from that BugDesk never sets: every editor got no bus,
 * so a save there never told the open pages (Alerts, Changes, the queues).
 */
const pageBus = () => window.__bugdesk?.eventBus ?? null;

/** Where a panel's editor comes from, mounted with the page's bus. */
const panel = (load) => async (el, { eventBus, ...props } = {}) => (await load())(el, { ...props, eventBus: eventBus || pageBus() });

/**
 * The sidebar, sorted by WHO A CHANGE AFFECTS (STORY-0032), then by topic:
 *
 *   You           Profile, Behaviour        — your profile, or this browser
 *   This project  Record types, Workflow,   — project.json / bugdesk.json,
 *                 Team, Alerts, Git           committed: everyone who pulls
 *
 * It used to be FlexDesk's General ("Workspace behavior and notifications")
 * holding everything, with nothing to say that Saving and git or Record types
 * changed things for the whole team while the row beside them changed only
 * this browser. A category's `section` is the sidebar heading it is listed
 * under; `shared` puts the "applies to everyone" line under its title;
 * `groupOrder` orders its groups where schema order cannot (a FlexDesk row
 * moved onto the page comes first in it). Every
 * project editor is drawn on the page (`type: 'panel'`); none opens a window.
 * FlexDesk's own General and Windows are left with no rows we offer, so the
 * page does not list them.
 */
export const BUGDESK_SETTINGS_SLICE = {
    categories: [
        { id: 'profile', label: 'Profile', icon: 'badge', section: 'You', order: 11, noReset: true,
          description: 'Who you are here: the names your work, and your assistant\'s comments, are signed with. Saved to your profile beside the store.' },
        { id: 'behaviour', label: 'Behaviour', icon: 'tune', section: 'You', order: 12,
          groupOrder: ['Pages', 'Records', 'Saving', 'Windows'],
          description: 'How BugDesk behaves for you. Other people choose their own.' },
        { id: 'recordTypes', label: 'Record types', icon: 'schema', section: 'This project', order: 21, shared: true,
          description: 'Each record type\'s fields and statuses, and how new records of it are named and numbered.' },
        // Its Tracker section is saved to the tracker's own project.json.
        { id: 'workflow', label: 'Workflow', icon: 'account_tree', section: 'This project', order: 22,
          shared: 'Changes here apply to everyone who pulls this repo — and in the Tracker section, to everyone who uses that tracker.',
          description: 'What each record type can do: its actions, and the flows they run' },
        { id: 'team', label: 'Team', icon: 'group', section: 'This project', order: 23, shared: true,
          description: 'Everyone who can be assigned work on this repo.' },
        { id: 'alerts', label: 'Alerts', icon: 'notifications', section: 'This project', order: 24, shared: true,
          description: 'Rules that raise an alert when a record starts matching a condition.' },
        { id: 'git', label: 'Git', icon: 'commit', section: 'This project', order: 25, shared: true,
          description: 'Whether each save commits the record it wrote, and whether that commit is pushed.' },
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
            // Not stored values — these rows are editors drawn on the page (see the
            // schema below). Each carries a default so the settings store has a
            // shape for the path and the row renders like every other one.
            autosave: null,
            tracker: null,
            collaborators: null,
            recordTypes: null,
            workflow: null,
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

        // ── You › Profile ───────────────────────────────────────────────
        'bugdesk.humanName': {
            type: 'text', category: 'profile', group: 'Authorship',
            label: 'Your name',
            description: 'The name shown as assignee and comment author on everything you file. Saved to your per-user profile beside the store, so it follows you rather than this browser. Entering a different name switches to that person\'s profile (creating it if it is new), along with their saved filters. Leave blank to use the server\'s BUGDESK_HUMAN default. Takes effect after a reload.',
            defaultValue: '', placeholder: '(server default)', reloadHint: true,
        },
        'bugdesk.agentName': {
            type: 'text', category: 'profile', group: 'Authorship',
            label: 'Agent name',
            description: 'The name your AI assistant signs its comments with. Left blank it is derived from your own name as <you>_agent, which is what keeps two people\'s assistants from signing identically. Takes effect after a reload.',
            defaultValue: '', placeholder: '(server default)', reloadHint: true,
        },

        // ── You › Behaviour ─────────────────────────────────────────────
        // STORY-0043. Whether you see the Tracker section at all: yours, in your
        // personal preferences, the same in every project. It reloads the page,
        // because the top bar is built from it at load (ticketdesk/tracker_setting.js).
        'bugdesk.tracker': {
            type: 'panel', category: 'behaviour', group: 'Pages',
            label: 'Tracker',
            description: 'Show the Tracker, the follow-up tracker shared by every project, as a page in the top bar. Yours alone, saved to your profile and the same in every project. Switching it reloads BugDesk; nothing is deleted.',
            buttonLabel: 'Go to Behaviour',
            icon: 'space_dashboard',
            defaultValue: null,
            mount: panel(async () => (await import('../ticketdesk/tracker_setting.js')).mountTrackerSetting),
        },
        // Both answers are reasonable and the difference is about how someone
        // works, not about which is correct — so it is a setting rather than a
        // decision made for everybody.
        'bugdesk.modifierOpen': {
            type: 'select', category: 'behaviour', group: 'Records',
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
        // A habit, so each person's: in their profile, laid over the project's
        // value until they choose (ticketdesk/autosave_setting.js).
        'bugdesk.autosave': {
            type: 'panel', category: 'behaviour', group: 'Saving',
            label: 'Auto-save',
            description: 'Whether a record you are editing saves by itself, and how long after you stop typing. Yours alone, saved to your profile.',
            buttonLabel: 'Go to Behaviour',
            icon: 'save',
            defaultValue: null,
            mount: panel(async () => (await import('../ticketdesk/autosave_setting.js')).mountAutosaveSetting),
        },
        // FlexDesk's, read by its managed windows (which BugDesk's floats are),
        // listed here rather than on a Windows page of one row.
        'window.animateMinimize': {
            type: 'boolean', category: 'behaviour', group: 'Windows',
            label: 'Animate minimize/restore',
            description: 'Animate floating windows toward and from the taskbar when minimizing and restoring.',
            defaultValue: true,
        },

        // ── This project › Record types ─────────────────────────────────
        // Custom fields, hidden built-ins, custom statuses and numbering per
        // record type — a schema, edited on the page.
        'bugdesk.recordTypes': {
            type: 'panel', category: 'recordTypes', group: 'Record types',
            label: 'Record types',
            description: 'Your own fields (text, number, date, yes/no, choice) and statuses per record type, which optional built-in fields each type shows, and how new records are named: the prefix (BUG, EPIC, STORY, …), zero-padding, first number and increment. Existing records keep their names. Saved in the shared project.json beside the stores.',
            buttonLabel: 'Go to Record types',
            icon: 'schema',
            defaultValue: null,
            mount: panel(async () => (await import('../ticketdesk/schema_editor.js')).mountRecordTypes),
        },

        // STORY-0030: one workflow. A record type's actions, the flows they run
        // (a flow's "Change the status" step is the move) and its mass actions.
        'bugdesk.workflow': {
            type: 'panel', category: 'workflow', group: 'Workflow',
            label: 'Workflow',
            description: 'What each record type can do: its actions — moves among them — each offered in some statuses and running a flow (ask a question, set or clear a field, add a comment, check a field and branch, change the status), and its mass actions for ticked records. Flows are shared, and say which records and types they are for. Saved in the shared project.json beside the stores; only what differs from the built-in way is saved.',
            buttonLabel: 'Go to Workflow',
            icon: 'account_tree',
            defaultValue: null,
            mount: panel(async () => (await import('../ticketdesk/workflow_page.js')).mountWorkflowPage),
        },

        // A roster is a list of records, edited on the page.
        'bugdesk.collaborators': {
            type: 'panel', category: 'team', group: 'Team',
            label: 'Collaborators',
            description: 'Everyone who can be assigned work on this repo, from the shared bugdesk.json beside the stores. Setting your name adds you automatically; edit the list here to add someone who has not opened it yet, or to remove someone who has left.',
            buttonLabel: 'Go to Team',
            icon: 'group',
            defaultValue: null,
            mount: panel(async () => (await import('../ticketdesk/collaborators.js')).mountTeam),
        },

        // Alert rules: a condition, a level, and how it is shown.
        'bugdesk.alerts': {
            type: 'panel', category: 'alerts', group: 'Alerts',
            label: 'Alert rules',
            description: 'Rules that raise an alert when a record starts matching a condition — any filter, custom fields included — as info, a warning or an alert, in the bottom panel and optionally as a toast. Alerts only fire while BugDesk is open; changes made while it was closed are not reported. Which alerts you have read is yours.',
            buttonLabel: 'Go to Alerts',
            icon: 'notifications',
            defaultValue: null,
            mount: panel(async () => (await import('../ticketdesk/alerts.js')).mountAlertsRules),
        },

        // Commit after save, push after commit — the Changes tab's two switches.
        'bugdesk.git': {
            type: 'panel', category: 'git', group: 'Git',
            label: 'Commit and push',
            description: 'Whether each save commits the record it wrote, and whether that commit is pushed. Off by default. The bottom panel\'s Changes tab lists what is uncommitted, with its diff, and commits and pushes by hand. Auto-save is each person\'s own, under Behaviour.',
            buttonLabel: 'Go to Git',
            icon: 'commit',
            defaultValue: null,
            mount: panel(async () => (await import('../ticketdesk/changes_pane.js')).mountGitSettings),
        },
    },
};
