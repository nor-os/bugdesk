---
id: 47
type: story
title: "The Tracker home is a standard, customisable dashboard"
status: review
parent: 45
phase:
assignee: norman
reporter: norman
due:
points: 8
subsystem: ui
labels: []
links: []
created: 2026-10-16
updated: 2026-10-17T14:50Z
---

## Description

Rebuild the Tracker home (`tracker_pages.js`, `mountTracker` / `createTrackerContent`)
as a standard dashboard. It ships as a default project dashboard that can be
edited, rather than as a hand-built page.

The standard dashboard only has chart and KPI tiles today (`model.js:25`). What
the Tracker home shows needs more tile types than that:

- a **record list** tile: a filtered, sorted list of records (Overdue, Due in
  the next N days, Needs a name or a date), with the row context menu the
  Tracker rows have today (`tracker_pages.js:326`)
- a **people** tile: open items grouped by assignee
- the **scope picker** (Everyone / Assigned by me / Out with others), as a
  dashboard-level filter that every tile follows

Open questions for refinement, with norman's answers (2026-10-17):

- Do the new tile types belong in FlexDesk (upstream TileGrid tiles) or in
  BugDesk? **FlexDesk.** The record list tile (with its row context menu), the
  people tile and the dashboard-level scope filter are generic, so they are
  built upstream in `@flexdesk/tiles` with FlexDesk tests, and released to npm.
  BugDesk keeps only the adapters: the data source over its records and the row
  menu's actions.
- Is the default home a dashboard that is seeded into `project.json` (and can
  then drift), or a built-in that the user forks to edit? **A built-in.** The
  default Tracker home is defined in BugDesk's code. Editing it saves a project
  dashboard override (in project.json) that replaces it.
- What does "reset to default" do? **It removes the override**, so the built-in
  shows again.

The Tracker home must still show Overdue, Due in the next N days, People, and
Needs a name or a date, with the scope picker (Everyone / Assigned by me / Out
with others).

## Acceptance criteria

- [x] The Tracker chip (and its F-key) opens the Tracker home as a standard dashboard (the same grid, header and tile settings as every other dashboard), both in standalone TicketDesk and on a project page with the Tracker beside it
- [x] With no override saved, the home is the built-in default: Overdue, Due in the next 7 days, Who has what (people), and Needs a name or a date
- [x] A record list tile lists a store's open records through a built-in view or a filter, sorted (worst first for Overdue, soonest first by target date), with a count, a line saying what empty means, and "Open as a list"; a click on a row opens the record as a tab in the dashboard's tile, Ctrl/⌘-click opens it the modified way, and Enter/Space does what a click does
- [x] Right-clicking a list row shows the menu the old Tracker rows had: Open, Open beside, Open in a window, Everything on <assignee>, Everything in this project, Copy reference, Delete…, and each entry does what it says
- [x] A people tile shows open items grouped by assignee, worst first (overdue count, then how late), with Nobody as a row of its own, and overdue / undated / next-date pills; a click opens a flat list of that person's open items
- [x] A scope picker (Everyone / Assigned by me / Out with others) sits in the dashboard's header; every tile on it (chart, KPI, list, people) follows the scope, a click-through list carries it, and the choice is kept with the tab across a reload
- [x] List and people tiles can be added to any dashboard ("Add list", "Add people") and configured in the tile's settings (records, view or filter, sort, how many rows)
- [x] Editing the built-in home (moving, resizing, adding, removing or configuring a tile) saves an override in the tracker's project.json that replaces the built-in; the header then says it is customised and offers "Reset to default"
- [x] "Reset to default" asks first, removes the override from project.json, and shows the built-in again without a reload; the override is never listed as an ordinary dashboard in the rail
- [x] The list tile, the people tile and the scope picker are FlexDesk's (`@flexdesk/tiles`), with FlexDesk tests, released to npm and synced into BugDesk (`sync-flexdesk.mjs --check` passes); BugDesk adds only the data adapter and the row actions
- [x] With the Tracker switched off (STORY-0043), the Tracker home is not reachable and nothing in it is deleted; switched back on, an override saved before is used again
- [x] The in-app help, README and CHANGELOG describe the Tracker home dashboard, the list and people tiles, the scope picker and Reset to default

## History

- 2026-10-17 · norman_agent · status: draft -> refined
- 2026-10-17 · norman_agent · status: refined -> in-progress
- 2026-10-17 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-17 · norman_agent · status: in-progress -> review
- 2026-10-17 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-16T06:30Z · norman_agent

Filed at norman's request under EPIC-0045. Probably the largest of the three, because the tile types it needs don't exist yet.

### 2026-10-17T10:08Z · norman_agent

Refined with norman's answers of 2026-10-17 (see the description): the new
tiles and the scope filter go upstream into FlexDesk; the Tracker home is a
built-in default whose edits save a project.json override, and Reset removes
it. 12 criteria, 8 points, under EPIC-0045. Taking it on in the ultra/track-A
worktree.

### 2026-10-17T11:17Z · norman_agent

Built on branch ultra/track-A (c7afd0b), not merged yet; stays in-progress
until integration.

- The Tracker chip opens the Tracker home, the page's own dashboards page
  in "home" mode (`createHomeContent`, `dashboards/homes.js`). In
  standalone TicketDesk it is also `home`, the landing page. The
  hand-built `ticketdesk/tracker_pages.js` and its CSS are gone.
- Built-in default: Overdue, Due in the next 7 days, Who has what, Needs a
  name or a date, over the tracker's own views. The first edit saves the
  whole dashboard as `home-tracker` (`"home": "tracker"`) in the
  TRACKER's `.bugdesk/project.json` (via `/t/api` on a project page), so
  every project shows the same home. The header badge then reads
  Customised and Reset to default appears; Reset asks, deletes the entry
  and redraws the built-in. Overrides are filtered out of the rails.
- New tiles everywhere: List (source, types, view or filter, order,
  open-only) and People (open records by assignee, worst first). A list
  row opens as a tab in the dashboard's tile; Ctrl/⌘ per the setting;
  Enter/Space; Alt+T/N/Shift+H/Shift+V as in tables; drag to a tile;
  right-click gives the old Tracker row menu. A new tile's Records start
  on the dashboard's own section.
- Everyone / Assigned by me / Out with others in every dashboard's
  header. Every tile is resolved under it (chart, KPI, list, people),
  click-throughs carry it, and the tab keeps it (`props.scope`); it is
  never written into the dashboard. Bugs got a Reporter filter field so
  "Assigned by me" means the same there.
- The tiles and the scope are upstream: FlexDesk STORY-0072, released as
  flexdesk 0.16.1 (not 0.17.0: FlexDesk STORY-0069 reserves 0.17.0 for
  the EcoSim-migration release now in flight), synced into ui/vendor.

Checked on a scratch server (port 8781) in headless Edge over CDP, with
real clicks and keys. On a project page: F3 opens the built-in home; row
click (tab in the tile), Ctrl-click (background tab), Enter; the right-
click menu's Open beside, Open in a window, Everything on sam, Everything
in this project, Copy reference and Delete (asked, deleted, row gone);
a person; Open as a list; the three scopes (byme dropped alice's
STORY-0006, others dropped norman's and nobody's), the scoped
click-through, and the scope after a reload; Add list + its settings
saved the override (Customised, Reset shown, not in the rail), kept
after a reload, and Reset (asked) put the built-in back; Copy to
personal; Tracker switched off (no chip, override kept) and on (override
back). In standalone TicketDesk: lands on the home, a row opens the
item, an edit and a Reset. A Bugs dashboard: Add list / Add people over
bugs, a bug row opens the bug. Not exercised there: the menu's own
Open entry (the same call as a click) and a chart or KPI under a scope
(covered by test-dashboards and test-dashboards-dom).
Tests: test-ui 222, test-tracker 35, test-dashboards 58,
test-dashboards-dom 49, test-dashboards-tracker 14,
test-dashboards-example 8, test-tracker-off 17, test-dom 201; eslint 0
errors; check-graph OK; FlexDesk 99 suites green, none skipped.

### 2026-10-17T12:12Z · norman_agent

Review findings fixed on ultra/track-A. A list tile over bugs no longer
offers "Target date" as its order (bugs have none): the Order setting is
per store, a bugs list defaults to last updated, and an older bugs tile
saved with the target-date order is now listed by last updated instead of
by reference. Two things the old hand-built Tracker page had are gone,
on purpose: its header's **New** button (the top bar's New Item still
creates tickets) and its "N open · M overdue" line (each tile carries its
own count). The CHANGELOG now says so. The row menu reads "Open beside
the dashboard" because it is offered on every dashboard, not only the
Tracker home; the README follows. Still open, for norman: FlexDesk went
out as 0.16.1, not 0.17.0 (FlexDesk STORY-0069 keeps 0.17.0 for the
EcoSim-migration release), and it carries BUG-0016's SortableList fix.
The home's tab reads "tracker" because FlexDesk titles a tab opened from
the top bar with its kind id (Backlog's reads "backlog" too); the fix
belongs in FlexDesk.

### 2026-10-17T14:50Z · norman_agent

Handing back for review. On main and pushed: 699268a (refined and taken on), 21c67d2 (the Tracker home is a standard dashboard, with list and people tiles), 6894c3c (criteria met), 677aa5f (review fix: a bugs list tile is not ordered by a target date).

Built: the Tracker chip and F-key open the Tracker home, a standard dashboard. The default is built in (Overdue, Due in the next 7 days, Who has what, Needs a name or a date); the first edit saves `home-tracker` in the tracker's project.json, the header says Customised and offers Reset to default (asks, redraws without a reload; never in a rail). Every dashboard gets List and People tiles and an Everyone / Assigned by me / Out with others scope that every tile follows and the tab keeps. These are FlexDesk's (FlexDesk STORY-0072, e255cf4, released as 0.16.1 and synced); BugDesk adds the data adapters and the row actions. The old Tracker page's header New button and its "N open · M overdue" line are gone on purpose: the top bar's New Item creates tickets, and each tile carries its own count. The row menu entry is now "Open beside the dashboard", since it is on every dashboard.

Verified on a scratch BugDesk and on standalone TicketDesk (--tracker) in headless Edge over CDP with real input: home, tiles, row click and menu, scope across a reload, customise and Reset. Checked again on main at 4b75945 before this handback: server builds (0 errors), check-graph OK, eslint 0 errors, test-ui 225/225, test-tracker 35/35, test-dom 218/218, test-dashboards 59/59, test-dashboards-dom 58/58, test-dashboards-example 8/8, test-dashboards-tracker 14/14, test-tracker-off 17/17, sync-flexdesk --check matches flexdesk@0.16.1.

Open, for you to decide:
- FlexDesk went out as 0.16.1, not the 0.17.0 you named, because FlexDesk STORY-0069 reserves 0.17.0 for the migration release. It is new API in a patch release and also carries BUG-0016's SortableList fix. Say if you want 0.17.0 anyway; BugDesk then only changes the pin.
- The home's tab reads "tracker" in lower case (FlexDesk titles a chip-opened tab with the kind id). The fix is FlexDesk 1c4a986 on branch story-0048-home-tabs, not released yet (see STORY-0048).
- In a narrow list tile the title is dropped while the reference, assignee, due and status stay; it should be cut short instead (FlexDesk list tile CSS).
- Help and CHANGELOG say "beside" both for a row click (a tab in the same tile) and for "Open beside the dashboard" (a split).
- The row menu's own Open entry was not exercised on the real instance (same call as a click).
- The record was refined, claimed and commented on ultra/track-A and reached main at integration.
