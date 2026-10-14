---
id: 37
type: story
title: "Burndown: remaining points or items for an epic, phase or project"
status: draft
parent: 33
phase:
assignee:
reporter: norman
due:
points: 5
subsystem: ui
labels: [dashboards, charts, burndown]
links: [blocked-by 34]
created: 2026-10-14
updated: 2026-10-14T10:21Z
---

## Description

A burndown tile: how much of a scope is still unfinished, day by day, against an ideal line.

- **Scope**: one epic (with all its descendants), a phase, or all backlog items. In the tracker, a PROJ record
  is also a scope (see STORY-0038). For bugs, it is the open-bug count of a filter.
- **Unit**: points or item count.
- **Range**: from the scope's start to its due date. The start defaults to its earliest `created`, the end to
  its effective `due` or, without one, today. Both can be overridden.
- **Remaining on day d**: in-scope items created on or before d that were not in a `finished`-category status at
  d. The status at d is replayed from each record's `## History`. A record with no History counts as having had
  its current status since `created`, and a finished record without History counts as finished at `updated`.
  Custom statuses count by their category. A `dropped` item leaves the scope from the day it was dropped instead
  of burning down.
- **Shown**: remaining as a step line, a dashed ideal line from the starting total to zero at the end, and a
  "today" marker. When the scope grows during the range, the line jumps up rather than hiding it.

Points are the current estimates (History does not record points changes). The tile says so in its footer.

## Acceptance criteria

- [ ] For an epic with dated History, the burndown's remaining value on each day matches a hand count from the records' History sections
- [ ] The tile switches between points and item count, and between epic, phase and all-backlog scopes
- [ ] The ideal line runs from the starting total to zero at the scope's due date, or at the chosen end date
- [ ] Items added to the scope mid-range show as an upward step on their `created` date; dropped items leave the scope instead of burning down
- [ ] A custom status with category `finished` counts as burned down
- [ ] A bugs burndown shows the open-bug count of a filter over a date range
- [ ] The footer states that points are current estimates

## History

## Comments
