---
id: 38
type: story
title: "Dashboards can chart tracker records"
status: draft
parent: 33
phase:
assignee:
reporter: norman
due:
points: 3
subsystem: ui
labels: [dashboards, tracker]
links: [blocked-by 36]
created: 2026-10-14
updated: 2026-10-14T10:21Z
---

## Description

When the tracker is available (merged into the project, or BugDesk running in tracker mode), the tracker's
records are a third tile source next to bugs and backlog. The tracker's own fields and schema apply, and the
`due`/overdue state is a field that can be charted, for example overdue items per assignee. A burndown can scope
to a PROJ record (STORY-0037).

The tracker store is loaded as a separate module copy (`/js/ticketdesk@t/`, `/t/api`). The dashboard has to
read tracker records from there, without mixing them into the project's backlog.

## Acceptance criteria

- [ ] With the tracker available, a tile can choose the tracker as its source and chart any tracker field
- [ ] Overdue / due-this-week / no-date can be charted per assignee
- [ ] A burndown can scope to a PROJ record and its descendants
- [ ] With the tracker disabled, the tracker source is not offered, and a saved tile that used it shows an explanatory empty state instead of an error

## History

## Comments
