---
id: 16
type: story
title: "Filter, search and show columns by custom fields"
status: in-progress
parent: 3
phase:
assignee: norman_agent
reporter: norman
due:
points: 8
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-12T13:40Z
---

## Description

Custom fields (STORY-0013) work everywhere built-in fields do in the lists:
- as conditions in the filter editor, with the operators that suit each type
  (before and after for dates, one-of for choices)
- in search
- as columns you can add to the bug queue, the backlog board and search
  results; they are not shown by default

TASK-0004 ("not before" date) is the worked example. It ships a sample field and
a sample filter that uses it.

## Acceptance criteria

- [x] The filter editor offers every custom field of the types in view, with operators that suit its type: contains for text, comparisons for number and date, one-of for choice, is/is not for yes/no
- [x] A saved filter on a custom field keeps working after a reload and shows the same records as before
- [x] Full-text search finds a record by the value of a text or choice custom field
- [ ] Custom fields can be added as columns to the bug queue, the backlog board and search results; they are hidden by default and sort correctly by type (dates as dates, numbers as numbers)
- [x] A filter or column naming a field that was later removed shows a visible "unknown field" marker instead of failing or silently matching nothing
- [ ] TASK-0004's "not before" field and its sample filter work end to end as the example

## History

- 2026-10-05 · norman_agent · status: draft -> refined
- 2026-10-12 · norman_agent · status: refined -> in-progress
- 2026-10-12 · norman_agent · assignee: (unset) -> norman_agent

## Comments

### 2026-10-05T21:14Z · norman_agent

Refined: 6 criteria, 8 points, under EPIC-0003. This is the largest of the
four because it touches the filter engine, search and three tables. TASK-0004
now sits under it as the worked example; it stays draft until its own work starts.

### 2026-10-12T13:40Z · norman_agent

Progress, in 04b5a11. Four of six criteria are met; the other two are open.

- Done: the filter editor offers every custom field of the store under
  "Custom fields". Operators by type: contains etc. for text, comparisons for
  number and date, one-of for choice, is/is not for yes/no. Saved filters keep
  working, since the keys are stable `cf.<name>`.
- Done: full-text search finds custom text and choice values.
- Done: a filter naming a removed field gets a ⚠ in the rail, and its
  description reads "unknown field".
- Open: **columns.** Neither DataTable can hide a column today. I filed FlexDesk
  STORY-0012 (`../FlexDesk/backlog/STORY-0012.md`, a column chooser); it is
  being built with FlexDesk STORY-0010 for the same release. The columns land
  here once BugDesk is on FlexDesk's DataTable (STORY-0008).
- Open: **TASK-0004's example** (the "not before" field and its sample
  filter), done together with the columns.
