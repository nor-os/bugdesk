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
updated: 2026-10-17T12:37Z
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

- [ ] The Bugs chip (and its F-key) opens the Bugs home, a standard dashboard (the same grid, header, scope picker and tile settings as every other dashboard); a fresh layout and a new split open on it too, since it is the landing page
- [ ] The Backlog chip (and its F-key) opens the Backlog home; a project with no bug store lands on the Backlog home
- [ ] With no override saved, the Bugs home is the built-in default: Open bugs by severity, Opened vs closed per week (the last 12 weeks), On me or my agent, Needs my reply, and In testing; "me" and "my agent" are whoever is looking at it, also on an override saved by somebody else
- [ ] With no override saved, the Backlog home is the built-in default: In progress, Ready to start (refined), In review, Drafts waiting for refinement, and Progress per epic (stories and tasks per epic, stacked by status category)
- [ ] The queue and the board are one click away from the home: a filter in the Bugs rail opens the queue and a view in the Backlog rail (Backlog) opens the board, as before; a Home row at the top of each section's rail, and the section's chip, bring the home back
- [ ] Editing a home (moving, resizing, adding, removing or configuring a tile) saves an override (`home-bugs`, `home-backlog`) in the project's own project.json that replaces the built-in; the header then says Customised and offers "Reset to default"; the override is never listed as a dashboard in a rail
- [ ] "Reset to default" asks first, removes the override from project.json, and shows the built-in again without a reload
- [ ] Everything that opened the queue or the board still does: the rail's filters, the Inspector's people, "Open as a list" and chart click-throughs on any dashboard, a record's breadcrumb back to its list, and queue or board tabs saved in a layout before this change (a tile's Bugs and Backlog tabs come back after the upgrade)
- [ ] The Tracker home (STORY-0047) and standalone TicketDesk behave as before
- [ ] The in-app help, README and CHANGELOG describe the Bugs and Backlog homes, their default tiles, the Home row and Reset to default

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
