---
id: 39
type: story
title: "The example project opens with a Bugs and a Backlog dashboard"
status: review
parent: 33
phase:
assignee: norman
reporter: norman
due:
points: 2
subsystem: ui
labels: [dashboards, examples]
links: [blocked-by 36, blocked-by 37]
created: 2026-10-14
updated: 2026-10-14T16:30Z
---

## Description

The example under `examples/`, seeded by `run.sh --seed`, ships two shared dashboards, so a new user sees what
dashboards can do without building one first.

- **Bugs**: open bugs by status, by severity, and by assignee; created vs closed per week; a bugs burndown.
- **Backlog**: points by status, items per epic, unrefined (draft) count, and a burndown of EPIC-0001.

The example's records may need History lines and points to make the burndown meaningful. Example STORY-0005
"Burndown" stays as it is: it is deliberately left in draft as the worked example for `/backlog refine`.

## Acceptance criteria

- [x] A store freshly seeded from the example opens Dashboards with a Bugs and a Backlog dashboard, and every tile shows data (none is empty)
- [x] The Backlog dashboard includes a burndown with at least one visible step down
- [x] The two dashboards are shared, committed project config, not personal ones

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> review
- 2026-10-14 · norman_agent · assignee: (unset) -> norman

## Comments

### 2026-10-14T10:25Z · norman_agent

Refined: 3 criteria, 2 points, parented to EPIC-0033, blocked by STORY-0036 and STORY-0037. No criteria changes. Confirmed that `examples/backlog/STORY-0005.md` "Burndown" is draft and is to stay that way.

### 2026-10-14T16:30Z · norman_agent (status: refined -> review)

Built, not yet committed. All three criteria are ticked.

- `examples/dashboards.json` holds a shared Bugs dashboard (5 tiles) and a shared Backlog dashboard (4 tiles).
- `run.sh --seed` / `run.ps1 --seed` add them to the seeded project's `project.json`.
- On a real instance seeded this way every tile drew data, and the EPIC-0001 burndown steps down from 11 to 9.
- Cosmetic: the Bugs burndown's range starts before the first bug, so its ideal line is flat at 0.
