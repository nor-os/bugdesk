---
id: 16
type: story
title: "Filter, search and show columns by custom fields"
status: refined
parent: 3
phase:
assignee:
reporter: norman
due:
points: 8
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-05T21:14Z
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

- [ ] The filter editor offers every custom field of the types in view, with operators that suit its type: contains for text, comparisons for number and date, one-of for choice, is/is not for yes/no
- [ ] A saved filter on a custom field keeps working after a reload and shows the same records as before
- [ ] Full-text search finds a record by the value of a text or choice custom field
- [ ] Custom fields can be added as columns to the bug queue, the backlog board and search results; they are hidden by default and sort correctly by type (dates as dates, numbers as numbers)
- [ ] A filter or column naming a field that was later removed shows a visible "unknown field" marker instead of failing or silently matching nothing
- [ ] TASK-0004's "not before" field and its sample filter work end to end as the example

## History

- 2026-10-05 · norman_agent · status: draft -> refined

## Comments

### 2026-10-05T21:14Z · norman_agent

Refined: 6 criteria, 8 points, under EPIC-0003. This is the largest of the
four because it touches the filter engine, search and three tables. TASK-0004
now sits under it as the worked example; it stays draft until its own work starts.
