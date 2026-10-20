---
id: 52
type: story
title: "Ticketdesk modules take their API base and config from their own URL"
status: review
parent: 51
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: ui
labels: [flexdesk, embedding]
links: []
created: 2026-10-20
updated: 2026-10-20T15:20Z
---

## Description

`ui/js/ticketdesk/instance.js` resolves the API relative to the DOCUMENT (`const API = 'api'`) and reads its
config from `window.__BUGDESK_CONFIG__`. Inside BugDesk that is right, because the page is served under
`/p/<name>/`. Inside another FlexDesk application (AI Desk, AI Desk STORY-0111,
`../aidesk/backlog/STORY-0111.md`) the document is that application's page, so every call goes to the wrong
server, and two projects cannot run side by side.

Derive the API base from the module's own URL (for the page's copy, `new URL('../../api', import.meta.url)`; the
tracker's copy keeps `/t/api`) and let a copy load its config from its own API when no page-wide config is
present. BugDesk's behaviour on its own pages does not change.

## Acceptance criteria

- [x] Served from `/p/<name>/` and `/t/`, BugDesk behaves exactly as today, and the existing tests pass
- [x] Importing `/p/<name>/js/ticketdesk/pages.js` from a page at another path sends every API call and the `/api/events` stream to `/p/<name>/api/`
- [x] Two projects' modules imported into one page each talk to their own project and keep separate state
- [x] Without `window.__BUGDESK_CONFIG__`, a copy loads its config from its own API before it renders
- [x] The README has a section 'Embedding BugDesk' that names the entry point (`createTicketDeskContent`) and what the host provides (event bus, FlexDesk version, Material Symbols, tokens)
- [x] A test imports the modules under a different document URL and checks the API base

## History

- 2026-10-20 · norman_agent · status: draft -> refined
- 2026-10-20 · norman_agent · status: refined -> in-progress; assignee: -> norman_agent
- 2026-10-20 · norman_agent · status: in-progress -> review
- 2026-10-20 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-20T09:18Z · norman_agent

Refined: 6 criteria, 5 points, parented to EPIC-0051. The unhappy path is covered by the first criterion: nothing changes for BugDesk's own pages.

### 2026-10-20T15:20Z · norman_agent

Handing back for review. Built on branch `story-0052`, pushed, tip `70bfc4cd4b8aa940bca7eaad8ec6db8583d6941d` (not merged to main). AI Desk's phase 1 (AI Desk STORY-0103/0110, `../aidesk/backlog/`, branch `phase-1`) consumed it through its proxy for two projects side by side, with no fork or patch.

Built: a ticketdesk copy now takes everything from its own `import.meta.url` (API `<root>api`, live stream `<root>api/events`, tracker `<server>/t/api` keeping the proxy prefix). Without `window.__BUGDESK_CONFIG__` it fetches `<root>api/config` before it renders (top-level await in `core/page_config.js`); a host must not set that global. On BugDesk's own pages the API stays the relative `api` and the config is the page's. `index.html` and `install.js` build their configs through the shared `shapePageConfig` / `shapeTrackerConfig`.

The embed contract (README, section *Embedding BugDesk*):
- Entry point `js/ticketdesk/embed.js`, imported once per project from `/p/<name>/`: `createBugDeskEmbed({ eventBus, kindPrefix, logger })` loads both stores and the saved filters, and returns `content` (for `createContentRegistry`), `kinds` (for the taxonomy), `kind(name)`, `event(name)`, `filters()`, `start({ wm })` (SSE stream plus record-link and record-drop handlers, idempotent), `reload()`, `apiUrl(path)` and friends. The lower-level `createTicketDeskContent`, `createBacklogContent`, `createNewItemContent` are still there for hosts that want them.
- Every kind is `<kindPrefix><kind>`, except panels, which are `panel:<prefix><side>` so a stock FlexDesk window manager still treats them as chrome (review fix). A WM proxy rewrites the kind argument of the navigation calls; breadcrumbs come from BugDesk's own taxonomy. Two projects in one shell need distinct prefixes; a second prefix for the same copy throws.
- Store events are scoped the same way: `<p>bugs:changed`, `<p>backlog:changed`, `<p>store:changed`, `<p>project:changed`, `<p>git:changed`, and new `<p>filters:changed` when a saved filter is added, renamed or deleted.
- The host provides FlexDesk 0.16.1 under the same import-map names, the WM's `EventBus`, a stock `WindowManager`, Material Symbols, the listed stylesheets (three of them are global: `css/tokens.css`, `css/bugdesk_controls.css`, `css/tiling/tile.css`, said in the README), a proxy route for `/attachments/`, and a configured user.

Findings and decisions:
- BugDesk no longer has a local window manager fork: `install.js` builds the stock `@flexdesk/wm` `WindowManager`, and the old `tiling/wm.js` is gone. The README's FlexDesk section still described it; corrected. Only `tiling/kind_taxonomy.js` travels with the copy.
- `tiling/project_switcher.js` is page chrome: only `install.js` reaches it and it navigates the whole window to another `/p/<name>/`, so its `api/` stays relative. Documented in the README and the file.
- In an embedded copy the snooze notice names Settings › Record types instead of opening Settings, which reads page globals.

Ticked all six:
1. Own pages unchanged: all existing suites pass, and `/p/alpha/` loaded in Chromium with no console errors and every request to `/p/alpha/api/*`. `/t/` was not checked in a browser (no tracker on the scratch server); the tracker suites pass.
2. API and `/api/events` go to the copy's project: tests in `scripts/test-embed.mjs`, and in a browser through an emulated host at `/app/` every request went to `/bugdesk/p/{alpha,beta}/api/*`.
3. Two projects separate: tests, and in the browser a save on beta changed only beta's file, a disk edit on alpha emitted only alpha's events.
4. Config before render: test checks both `api/config` requests were made by the time the imports resolved.
5. README section *Embedding BugDesk*.
6. `scripts/test-embed.mjs`, 16 cases, wired into `npm test` (includes a real `@flexdesk/wm` `TileTree` case for the panel kinds).

`npm test`: all suites pass with Node 22. It cannot run as shipped in this WSL: `/usr/bin/node` is 18, too old for jsdom 29, and the Windows npm fails on Windows paths in `import()`. That is the environment and predates this story. One existing test (Tracker switch auto-save in `test-dom.mjs`) waited two ticks for a lazy import and failed on `/mnt/c` at the base commit too; it now waits for the row with a deadline.

Follow-ups filed (draft): STORY-0053 embed dashboards and the section homes; STORY-0054 a page-only `css/embed.css` bundle; STORY-0055 a read-only option in the embed contract for users without `bugdesk:edit`; STORY-0056 a polling file watcher so live updates work on WSL `/mnt/c` checkouts (BugDesk's own page misses them too); STORY-0057 `embed.backlog()` tree API instead of the host reading REST.
