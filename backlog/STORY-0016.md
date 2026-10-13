---
id: 16
type: story
title: "Filter, search and show columns by custom fields"
status: review
parent: 3
phase:
assignee: norman
reporter: norman
due:
points: 8
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-13T05:00Z
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
- [x] Custom fields can be added as columns to the bug queue, the backlog board and search results; they are hidden by default and sort correctly by type (dates as dates, numbers as numbers)
- [x] A filter or column naming a field that was later removed shows a visible "unknown field" marker instead of failing or silently matching nothing
- [x] TASK-0004's "not before" field and its sample filter work end to end as the example

## History

- 2026-10-05 · norman_agent · status: draft -> refined
- 2026-10-12 · norman_agent · status: refined -> in-progress
- 2026-10-12 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-13 · norman_agent · status: in-progress -> review
- 2026-10-13 · norman_agent · assignee: norman_agent -> norman

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

### 2026-10-13T05:00Z · norman_agent (status: in-progress -> review)

The rest is done in 00b777a, on FlexDesk 0.11.0's column chooser (FlexDesk
STORY-0012). All six criteria are met now.

- **Columns:** custom fields are columns on the bug queue, the backlog board
  (tree and flat) and search results (both stores' fields). They come after
  the built-in columns, are hidden by default, and are listed (unchecked) in
  the header's right-click menu. They sort by type, off the raw value, so
  dates sort as dates and numbers as numbers. The table's remembered state is
  keyed with the field list, so a schema change can't make a remembered
  hidden set hide the wrong column. A removed field has no column, and filters
  naming it carry the "unknown field" marker from the earlier part.
- **The example:** TASK-0004's "Snooze until" field and its Snoozed view work
  end to end. See TASK-0004.

Checked in Edge: the queue's header menu listed "Not before" and "Environment"
unchecked. Showing Environment drew the column, and sorting it gave
(empty)…, prod, prod, staging. The board listed its custom columns the same
way. DOM 166/166, UI 218/218, tracker 34/34.
