---
id: 39
type: story
title: "The example project opens with a Bugs and a Backlog dashboard"
status: draft
parent: 33
phase:
assignee:
reporter: norman
due:
points: 2
subsystem: ui
labels: [dashboards, examples]
links: [blocked-by 36, blocked-by 37]
created: 2026-10-14
updated: 2026-10-14T10:21Z
---

## Description

The example under `examples/`, seeded by `run.sh --seed`, ships two shared dashboards, so a new user sees what
dashboards can do without building one first.

- **Bugs**: open bugs by status, by severity, and by assignee; created vs closed per week; a bugs burndown.
- **Backlog**: points by status, items per epic, unrefined (draft) count, and a burndown of EPIC-0001.

The example's records may need History lines and points to make the burndown meaningful. Example STORY-0005
"Burndown" stays as it is: it is deliberately left in draft as the worked example for `/backlog refine`.

## Acceptance criteria

- [ ] A store freshly seeded from the example opens Dashboards with a Bugs and a Backlog dashboard, and every tile shows data (none is empty)
- [ ] The Backlog dashboard includes a burndown with at least one visible step down
- [ ] The two dashboards are shared, committed project config, not personal ones

## History

## Comments
