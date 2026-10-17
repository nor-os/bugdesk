---
id: 48
type: story
title: "Bugs and Backlog open on a home dashboard"
status: in-progress
parent: 45
phase:
assignee: norman_agent
reporter: norman
due:
points: 5
subsystem: ui
labels: []
links: [requires 47]
created: 2026-10-16
updated: 2026-10-17T13:48Z
---

## Description

Today the Bugs home is the queue table (`pages.js`, `mountQueues`), and the
Backlog home is the board (`mountBacklogBoard`). Each section should open on its
own home dashboard, a standard dashboard like the Tracker's (STORY-0047), with
the queue or board one click away in the rail.

Candidate default tiles:

- **Bugs:** open by severity, assigned to me or my agent, needs my reply,
  in testing, opened vs closed over time
- **Backlog:** in progress, ready (refined), in review, drafts waiting for
  refinement, progress per phase or epic

Open question, with norman's answer (2026-10-17):

- Should the home dashboard replace the queue and board as the landing page,
  or sit beside them as one more rail entry with a setting that picks the
  landing page? **It replaces them as the landing page.** Bugs and Backlog
  each open on a built-in home dashboard, with the same override and reset
  model as the Tracker home (STORY-0047): the built-in is defined in BugDesk's
  code, the first edit saves a project dashboard override in project.json that
  replaces it, and "Reset to default" removes the override. The queue table and
  the board are one click away in the rail. The default tiles are the
  candidate list above.

## Acceptance criteria

- [x] The Bugs chip (and its F-key) opens the Bugs home, a standard dashboard (the same grid, header, scope picker and tile settings as every other dashboard); coming back from another section it puts back the tab left open there, as every chip does, and a second click goes home; a fresh layout and a new split open on the home too, since it is the landing page
- [x] The Backlog chip (and its F-key) opens the Backlog home; a project with no bug store lands on the Backlog home
- [x] With no override saved, the Bugs home is the built-in default: Open bugs by severity, Opened vs closed per week (the last 12 weeks), On me or my agent, Needs my reply, and In testing; "me" and "my agent" are whoever is looking at it, also on an override saved by somebody else
- [x] With no override saved, the Backlog home is the built-in default: In progress, Ready to start (refined), In review, Drafts waiting for refinement, and Progress per epic (stories and tasks per epic, stacked by status category)
- [x] The queue and the board are one click away from the home: a filter in the Bugs rail opens the queue and a view in the Backlog rail (Backlog) opens the board, as before; a Home row at the top of each section's rail, and the section's chip, bring the home back
- [x] Editing a home (moving, resizing, adding, removing or configuring a tile) saves an override (`home-bugs`, `home-backlog`) in the project's own project.json that replaces the built-in; the header then says Customised and offers "Reset to default"; the override is never listed as a dashboard in a rail
- [x] "Reset to default" asks first, removes the override from project.json, and shows the built-in again without a reload
- [x] Everything that opened the queue or the board still does: the rail's filters, the Inspector's people, "Open as a list" and chart click-throughs on any dashboard, a record's breadcrumb back to its list, and queue or board tabs saved in a layout before this change (a tile's Bugs and Backlog tabs come back after the upgrade)
- [x] The Tracker home (STORY-0047) and standalone TicketDesk behave as before
- [x] The in-app help, README and CHANGELOG describe the Bugs and Backlog homes, their default tiles, the Home row and Reset to default

## History

- 2026-10-17 · norman_agent · status: draft -> refined
- 2026-10-17 · norman_agent · status: refined -> in-progress
- 2026-10-17 · norman_agent · assignee: (unset) -> norman_agent

## Comments

### 2026-10-16T06:30Z · norman_agent

Filed at norman's request under EPIC-0045. It reuses whatever tile types STORY-0047 adds.

### 2026-10-17T12:37Z · norman_agent

Refined with norman's answer of 2026-10-17 (see the description): the home
dashboards replace the queue and the board as the landing pages, with the
Tracker home's override and reset model. 10 criteria, 5 points, under
EPIC-0045. Taking it on in the ultra/track-A worktree.

### 2026-10-17T13:03Z · norman_agent

Built on branch ultra/track-A, not merged yet; stays in-progress until
integration.

- The Bugs and Backlog chips are new kinds, `bugs-home` and
  `backlog-home`, whose page is the section's home dashboard (the page's
  dashboards page in home mode, `createHomeContent`). `queues` and
  `backlog` stay the queue and the board, as pages under them, the way
  `tracker-tickets` sits under `tracker`, so every filter route, "Open as
  a list", chart click-through and Inspector person still opens them. The
  landing `home` leaf (and so a fresh layout and a new split) is the Bugs
  home, or the Backlog home in a project with no bug store.
- Built-ins in `dashboards/homes.js`. Bugs: Open bugs by severity,
  Opened and closed per week, On me or my agent, Needs my reply, In
  testing. Backlog: In progress, In review, Ready to start (refined, not
  epics), Waiting for refinement, Progress per epic (stories and tasks,
  stacked by status category). The first edit saves `home-bugs` /
  `home-backlog` in the project's own project.json; Reset to default
  deletes it. "On me or my agent" names no person: it is a new bug view,
  **On me or <agent>** (`on-us`), which also shows in the Bugs rail.
- A **Home** row at the top of every section's rail (the Tracker's too)
  opens the home and is marked while the main area shows it.
- A layout saved before this has its archived Bugs and Backlog page tabs
  under the old chip kinds; they are renamed as the layout is read
  (`migrateLayout`), so those tabs come back.

One criterion was reworded after refinement: the first one now says what
any chip does when you come back from another section (it puts back the
tab you left open there; a second click goes home). That is FlexDesk's
page memory, and the Tracker chip has always worked that way; making the
Bugs chip always jump home would have thrown away the tabs you left.

Checked on a scratch server (port 8781) in headless Edge over CDP, with
real clicks and keys, starting from a layout saved before the change:
the Bugs chip put back the archived Bugs tabs, a second click opened the
built-in Bugs home (five tiles, Built in, scope picker), F2 put back the
board and F2 again opened the Backlog home, F1 back. Active in the rail
opened the queue, Home brought the home back (marked), "Open as a list"
and an Inspector person opened the queue, the Backlog view opened the
board, the chip brought the Backlog home back, a list row opened the
item as a tab, a bar of Open bugs by severity opened the matching bugs,
and a bug's breadcrumb went back to that list. Removing a tile saved
`home-bugs` (Customised, Reset shown, not in the rail), kept after a
reload; Reset asked and put the built-in back without a reload. The
same for `home-backlog` (written to the project's project.json, nothing
in the tracker's). The Tracker home still showed its four tiles. Alt+H
split the tile and the new half showed the Bugs home; with no saved
layout the page landed on the Bugs home, and a backlog-only project on
the Backlog home with only Backlog and Tracker chips. Standalone
TicketDesk (tracker mode) still opened on the Tracker home, from its saved
layout and with none. Not exercised on
the real instance: "me" for a second person on a shared override
(covered by test-dashboards-dom). The tab of a home opened from a chip
reads its kind id (`bugs-home`), as the Tracker's reads `tracker`:
FlexDesk titles a bare open by its kind, and the fix belongs there.
Tests: test-ui 225, test-tracker 35, test-dashboards 59,
test-dashboards-dom 58, test-dashboards-tracker 14,
test-dashboards-example 8, test-tracker-off 17, test-dom 201; eslint 0
errors; check-graph OK; sync-flexdesk --check OK (no FlexDesk change).

### 2026-10-17T13:48Z · norman_agent

Review findings, on ultra/track-A:

- The `backlog` page is labelled "Items", not "Backlog board", so the
  crumb above "Open as a list" reads "Backlog › Items" instead of calling
  a flat list the board. Stale comments in kind_taxonomy.js that still
  called `queues` the Bugs chip and Home the bug queue are corrected.
- A bug's "Bugs" crumb (and Backspace) could close onto the Bugs home
  instead of the list the bug came from, when the home tab sat nearer.
  The homes (and the Tracker home) are now marked `overview`, and a
  FlexDesk change on branch story-0048-home-tabs (1c4a986, not yet
  released) makes Back prefer an open list to an open overview. The same
  change titles a chip-opened tab with the chip's label ("Bugs",
  "Backlog") instead of the kind id. Both checked in headless Edge with
  that FlexDesk build served from a scratch copy of ui/: list, home and
  bug side by side, the Bugs crumb and Backspace each went back to the
  list; F2 and F1 opened tabs named "Backlog". With the vendored 0.16.1
  the flag is ignored and behaviour is as before, until that FlexDesk
  change is released and synced.
- Criterion 1 still carries the reworded text (the chip puts back the tab
  left open in the section; a second click goes home). norman, please
  confirm that wording or ask for the chip to always jump home, which is a
  FlexDesk change.
