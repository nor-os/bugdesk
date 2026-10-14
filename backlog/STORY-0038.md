---
id: 38
type: story
title: "Dashboards can chart tracker records"
status: review
parent: 33
phase:
assignee: norman
reporter: norman
due:
points: 3
subsystem: ui
labels: [dashboards, tracker]
links: [blocked-by 36]
created: 2026-10-14
updated: 2026-10-14T16:30Z
---

## Description

When the tracker is available (merged into the project, or BugDesk running in tracker mode), the tracker's
records are a third tile source next to bugs and backlog. The tracker's own fields and schema apply, and the
`due`/overdue state is a field that can be charted, for example overdue items per assignee. A burndown can scope
to a PROJ record (STORY-0037).

The tracker store is loaded as a separate module copy (`/js/ticketdesk@t/`, `/t/api`). The dashboard has to
read tracker records from there, without mixing them into the project's backlog.

## Acceptance criteria

- [x] With the tracker available, a tile can choose the tracker as its source and chart any tracker field
- [x] Overdue / due-this-week / no-date can be charted per assignee
- [x] A burndown can scope to a PROJ record and its descendants
- [x] With the tracker disabled, the tracker source is not offered, and a saved tile that used it shows an explanatory empty state instead of an error

## History

- 2026-10-14 · norman_agent · status: draft -> refined
- 2026-10-14 · norman_agent · status: refined -> review
- 2026-10-14 · norman_agent · assignee: (unset) -> norman

## Comments

### 2026-10-14T10:25Z · norman_agent

Refined: 4 criteria (the disabled-tracker empty state covers the unhappy path), 3 points, parented to EPIC-0033, blocked by STORY-0036. The burndown criterion also depends on STORY-0037. Checked the description against the code: tracker modules load via `trackerModule()` / `/js/ticketdesk@t/` and `/t/api` in `instance.js`, as stated.

### 2026-10-14T16:30Z · norman_agent (status: refined -> review)

Built, not yet committed. All four criteria are ticked.

- Tracker records are a third source in tracker mode, and on a project page with the tracker on (read from `/t/api`, never mixed into the backlog).
- "Due (week)" split by assignee gives overdue / due this week / no date per person in one chart.
- A burndown can scope to a PROJ record and everything under it.
- With the tracker off, the source is not offered and a saved tracker tile shows an empty state.
