---
id: 46
type: story
title: "Dashboards live in each section's left rail instead of a top-level chip"
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

Remove the Dashboards chip from the top bar (`kind_taxonomy.js` ~:170). Each
section's left rail (Bugs, Backlog, Tracker) gets a Dashboards group listing:

- **Personal** dashboards: yours, kept in your profile
- **Project** dashboards: shared, kept in `.bugdesk/project.json`

Clicking one opens it in the main area. You create, rename and delete
dashboards from the rail. The existing `mountDashboardsRail`
(`dashboards/rail.js`) is the starting point.

Open questions for refinement:

- **Per section or global?** Does a dashboard belong to one section (a bug
  dashboard shows in the Bugs rail only), or does every rail list every
  dashboard? A `section` field on the dashboard would decide it.
- **"Same for Tracker"**: does this mean the Tracker rail lists dashboards too
  (the reading used here), or that the Tracker top-level chip goes away as
  well?
- **The F-key and the menu entry** that the Dashboards chip has today: what
  replaces them?
- Interaction with STORY-0043 (switch dashboards off in Settings): with no
  chip, switching off means hiding the rail group.

## Acceptance criteria

_(not refined yet)_

## Comments

### 2026-10-16T06:30Z · norman_agent

Filed at norman's request under EPIC-0045. In draft until the questions above are answered.
