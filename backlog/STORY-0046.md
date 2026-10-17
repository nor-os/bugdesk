---
id: 46
type: story
title: "Dashboards live in each section's left rail instead of a top-level chip"
status: review
parent: 45
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: ui
labels: []
links: []
created: 2026-10-16
updated: 2026-10-17T14:50Z
---

## Description

Remove the Dashboards chip from the top bar (`kind_taxonomy.js` ~:170). Each
section's left rail (Bugs, Backlog, Tracker) gets a Dashboards group listing:

- **Personal** dashboards: yours, kept in your profile
- **Project** dashboards: shared, kept in `.bugdesk/project.json`

Clicking one opens it in the main area. You create, rename and delete
dashboards from the rail. The existing `mountDashboardsRail`
(`dashboards/rail.js`) is the starting point.

Open questions for refinement, answered by norman on 2026-10-17:

- **Per section or global?** Per section. Each dashboard gets a `section`
  field: `bugs`, `backlog`, `tracker` or `all`, defaulting to the section it
  was created in. A section's rail lists the Personal and Project dashboards of
  its own section plus those marked `all`. A dashboard saved before this story
  has no `section` and is treated as `all`, so nothing goes missing.
- **"Same for Tracker"**: the Tracker rail lists dashboards too. The Tracker
  chip STAYS (whether it can be switched off is STORY-0043).
- **The F-key and the menu entry**: there is no top-level Dashboards element at
  all: no chip, no F-key. The chips after it move up a place, and the menu,
  the command palette and the help follow.
- **STORY-0043**: rescoped by norman. Dashboards are always on and cannot be
  switched off; that story is now about switching the Tracker off.

## Acceptance criteria

- [x] The top bar has no Dashboards chip in a project (Bugs, Backlog, Tracker) or in standalone tracker mode (Tracker only), and F1, F2, F3 go to those chips in order: there is no F-key for Dashboards
- [x] The Bugs, Backlog and Tracker rails each show a Dashboards group with a Project and a Personal list; each lists only the dashboards whose section is that section or `all`
- [x] "New dashboard" / "New personal dashboard" in a rail asks for a name, saves the dashboard with `section` set to that rail's section, and opens it in the main area; the chip of that section stays lit
- [x] Clicking a dashboard in a rail opens it in the main area of that section (the chip does not change, the rail stays the same)
- [x] A dashboard can be renamed, moved to another section (or "All sections"), and deleted from the rail (hover buttons and right-click menu); a rename or delete of the dashboard that is open updates the open page without a reload, and a delete asks first
- [x] A dashboard saved before this story (no `section`) is listed in every section's rail; a `section` value BugDesk does not know is listed as `all` and kept in the file unchanged
- [x] The example dashboards are seeded into their sections (Bugs, Backlog, Tracker); the help (Getting around, Dashboards, Keyboard), README and CHANGELOG describe the rail instead of the chip

## History

- 2026-10-17 · norman_agent · status: draft -> refined
- 2026-10-17 · norman_agent · status: refined -> in-progress
- 2026-10-17 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-17 · norman_agent · status: in-progress -> review
- 2026-10-17 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-16T06:30Z · norman_agent

Filed at norman's request under EPIC-0045. In draft until the questions above are answered.

### 2026-10-17T06:20Z · norman_agent

Refined with norman's answers of 2026-10-17 (see the description): per-section
dashboards with a `section` field (default: where it was created; none means
`all`), no top-level Dashboards element at all, Tracker chip stays. 7 criteria,
5 points, under EPIC-0045. Taking it on in the ultra/track-A worktree.

### 2026-10-17T07:15Z · norman_agent

Built on branch ultra/track-A (6f6f30a), not merged yet; stays in-progress
until integration.

- No Dashboards chip: `dashboards` is a page of the landing section now,
  with `backlog-dashboard` and `tracker-dashboard` beside it, so a
  dashboard opens under the chip of the rail it came from. F1/F2/F3 are
  Bugs/Backlog/Tracker in a project; standalone tracker mode has only
  Tracker.
- Each rail starts with "Project dashboards" and "Personal dashboards"
  for that section plus `all`. "Shared" now reads "Project", as this story
  names them. New dashboards get `section` = the rail's section. The pencil
  (or right-click › Rename or move…) renames and picks "Listed in"; the bin
  (or right-click › Delete dashboard) deletes after a confirm. The open page
  follows a rename or delete made in the rail without a reload.
- No `section`, or a value BugDesk does not know: listed everywhere, written
  back unchanged.
- Example dashboards: Bugs → bugs, Backlog → backlog, My tracker → tracker.

Checked on a scratch server (port 8781) in headless Edge over CDP, with real
clicks: the chips and F-keys, each rail's list, opening from the Bugs and
Backlog rails, creating in Backlog (project.json got `section: backlog`) and a
personal one in Tracker, rename + move to All sections with the page open
(tile kept), right-click delete of the open one (confirm, page moved on to
Backlog), tracker mode, the help's Keyboard and Dashboards topics, and no
Dashboards hit in Ctrl+K. Not done on the real instance: an unknown `section`
value (covered by test-dashboards and test-dashboards-dom only). Tests:
test-ui 222, test-tracker 35, test-dashboards 50, test-dashboards-dom 43,
test-dashboards-example 8, test-dashboards-tracker 7, test-dom 198; eslint 0
errors; check-graph OK.

### 2026-10-17T07:44Z · norman_agent

Review fixes on ultra/track-A:

- A rename that leaves "Listed in" alone keeps a `section` BugDesk does not
  know (e.g. `reports`) as written; only a move to a real section replaces it.
- A rail marks a dashboard only while its own section's main area shows that
  dashboard: not while the queue or board is open, and not in another
  section's rail. A page that closes takes its mark with it.
- The pane header reads the open dashboard's name (and follows a rename),
  not "Dashboards".
- A dashboard listed under a store this project has not got (a `bugs` one in
  a backlog-only project, say from a copied project.json) is listed in every
  section, with a tooltip saying why, so it can still be opened, moved or
  deleted. Tracker dashboards are the exception: with no tracker (not merged,
  or switched off later by STORY-0043) they wait, kept, unlisted.
- My previous comment's stamp read 09:30Z, local time written as UTC; it is
  corrected to 07:15Z, the time of that commit.

Checked on a scratch server (8781) in headless Edge over CDP with real
clicks: renamed 'Weird' (section `reports`) to 'Weird 2' via the pencil,
project.json kept `reports`; the header showed 'Weird 2'; with the Active
queue open the Bugs rail marked nothing, and F2/F3 marked only the section's
own open dashboard; a backlog-only project listed its copied `bugs` dashboard
with the tooltip.

### 2026-10-17T14:50Z · norman_agent

Handing back for review. On main and pushed: 091c235 (refined and taken on), c1797dc (dashboards in each section's rail, no Dashboards chip), 93bf815 (criteria met), 8ce5a06 (review fixes: the rail marks only the open dashboard; renames keep unknown sections).

Built: no Dashboards chip; F1..F3 are Bugs, Backlog, Tracker. Each rail has a Dashboards group (Project and Personal) listing that section's and `all` dashboards, with New, rename, move (Listed in), delete (asks first) from hover buttons and right-click. A rail marks a dashboard only while its section's main area shows it. The pane header follows a rename. A dashboard with no `section` is listed everywhere; an unknown section is listed as `all` and kept unchanged on rename. In a project without that store, a `bugs` or `backlog` dashboard is listed everywhere, with a tooltip; a tracker dashboard with no tracker stays hidden but kept. Example dashboards are seeded per section. Help, README and CHANGELOG describe the rail.

Verified on a scratch BugDesk in headless Edge over CDP with real input: create, open, rename, move, delete from each rail, the marks, an old layout restoring. Checked again on main at 4b75945 before this handback: server builds (0 errors), check-graph OK, eslint 0 errors, test-ui 225/225, test-tracker 35/35, test-dom 218/218, test-dashboards 59/59, test-dashboards-dom 58/58, test-dashboards-example 8/8, test-dashboards-tracker 14/14, test-tracker-off 17/17, sync-flexdesk --check matches flexdesk@0.16.1.

Open, for you to judge:
- After a rename in the rail, or a delete of the open dashboard, the tab's saved title and label keep the old name; the page falls back to the section's first dashboard, not its home. The pane header is right once the page renders.
- Moving the open dashboard to another section leaves it open on the old section's page, unlisted in that rail.
- A layout saved before this story with an old `dashboards` main tab restores under the Bugs chip whatever the dashboard's section (one-time).
- The Dashboards group always shows in full; a long list pushes the filters down, and there is no collapse.
- Tracker dashboards are unreachable while the project has no tracker (also with the Tracker switched off, STORY-0043); they stay in the file.
- `run.sh --seed` was not run end to end; seeding is covered by test-dashboards-example.
- The record was refined, claimed and commented on ultra/track-A and reached main at integration.
