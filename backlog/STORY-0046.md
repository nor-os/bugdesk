---
id: 46
type: story
title: "Dashboards live in each section's left rail instead of a top-level chip"
status: in-progress
parent: 45
phase:
assignee: norman_agent
reporter: norman
due:
points: 5
subsystem: ui
labels: []
links: []
created: 2026-10-16
updated: 2026-10-17T06:20Z
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

- [ ] The top bar has no Dashboards chip in a project (Bugs, Backlog, Tracker) or in standalone tracker mode (Tracker only), and F1, F2, F3 go to those chips in order: there is no F-key for Dashboards
- [ ] The Bugs, Backlog and Tracker rails each show a Dashboards group with a Project and a Personal list; each lists only the dashboards whose section is that section or `all`
- [ ] "New dashboard" / "New personal dashboard" in a rail asks for a name, saves the dashboard with `section` set to that rail's section, and opens it in the main area; the chip of that section stays lit
- [ ] Clicking a dashboard in a rail opens it in the main area of that section (the chip does not change, the rail stays the same)
- [ ] A dashboard can be renamed, moved to another section (or "All sections"), and deleted from the rail (hover buttons and right-click menu); a rename or delete of the dashboard that is open updates the open page without a reload, and a delete asks first
- [ ] A dashboard saved before this story (no `section`) is listed in every section's rail; a `section` value BugDesk does not know is listed as `all` and kept in the file unchanged
- [ ] The example dashboards are seeded into their sections (Bugs, Backlog, Tracker); the help (Getting around, Dashboards, Keyboard), README and CHANGELOG describe the rail instead of the chip

## History

- 2026-10-17 · norman_agent · status: draft -> refined
- 2026-10-17 · norman_agent · status: refined -> in-progress
- 2026-10-17 · norman_agent · assignee: (unset) -> norman_agent

## Comments

### 2026-10-16T06:30Z · norman_agent

Filed at norman's request under EPIC-0045. In draft until the questions above are answered.

### 2026-10-17T06:20Z · norman_agent

Refined with norman's answers of 2026-10-17 (see the description): per-section
dashboards with a `section` field (default: where it was created; none means
`all`), no top-level Dashboards element at all, Tracker chip stays. 7 criteria,
5 points, under EPIC-0045. Taking it on in the ultra/track-A worktree.
