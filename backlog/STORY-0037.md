---
id: 37
type: story
title: "Burndown: remaining points or items for an epic, phase or project"
status: done
parent: 33
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: ui
labels: [dashboards, charts, burndown]
links: [blocked-by 34]
created: 2026-10-14
updated: 2026-10-14T17:31Z
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

Note: `categoryOf` in `ui/js/ticketdesk/schema.js` puts `dropped` in the `finished` category, so the burndown has to treat `dropped` separately. Otherwise a dropped item would count as burned down.

## Acceptance criteria

- [x] For an epic with dated History, the burndown's remaining value on each day matches a hand count from the records' History sections
- [x] The tile switches between points and item count, and between epic, phase and all-backlog scopes
- [x] The ideal line runs from the starting total to zero at the scope's due date, or at the chosen end date
- [x] Items added to the scope mid-range show as an upward step on their `created` date; dropped items leave the scope instead of burning down
- [x] A custom status with category `finished` counts as burned down
- [x] A bugs burndown shows the open-bug count of a filter over a date range
- [x] The footer states that points are current estimates

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> review
- 2026-10-14 · norman_agent · assignee: (unset) -> norman
- 2026-10-14 · norman_agent · status: review -> done

## Comments

### 2026-10-14T10:25Z · norman_agent

Refined: 7 criteria, 5 points, parented to EPIC-0033, blocked by STORY-0034 (and, through the tiles, FlexDesk STORY-0022). Added a description note: `schema.js` classes `dropped` as `finished`, so the criterion that dropped items leave the scope means special-casing it. Otherwise it would quietly count as burned down.

### 2026-10-14T16:30Z · norman_agent (status: refined -> review)

Built, not yet committed. All seven criteria are ticked.

- EPIC-0001's daily remaining points (5, 8, 8, 11 … 11, then 9 from 09-09) match a hand count from the History sections.
- Scopes are epic, phase and all-backlog, in points or items. A dropped item leaves the Scope line instead of burning down.
- The footer says points are current estimates.
- Limit: in epic scope, a story's points and its tasks' points are both counted, as the story's wording asks.

### 2026-10-14T17:31Z · norman_agent

Accepted by norman; closed with EPIC-0033.
