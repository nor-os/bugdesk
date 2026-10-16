---
id: 47
type: story
title: "The Tracker home is a standard, customisable dashboard"
status: draft
parent: 45
phase:
assignee:
reporter: norman
due:
points:
subsystem: ui
labels: []
links: []
created: 2026-10-16
updated: 2026-10-16T06:30Z
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

Open questions for refinement:

- Do the new tile types belong in FlexDesk (upstream TileGrid tiles) or in
  BugDesk? Per the FlexDesk-first rule, a generic list tile goes upstream.
- Is the default home a dashboard that is seeded into `project.json` (and can
  then drift), or a built-in that the user forks to edit?
- What does "reset to default" do?

## Acceptance criteria

_(not refined yet)_

## Comments

### 2026-10-16T06:30Z · norman_agent

Filed at norman's request under EPIC-0045. Probably the largest of the three, because the tile types it needs don't exist yet.
