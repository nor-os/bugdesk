---
id: 1
type: story
title: "Add Conversion journeys"
status: review
parent: 19
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: unsorted
labels: []
links: []
created: 2026-10-02
updated: 2026-10-12T14:07Z
---

## Description

- bugs that are transformed into backlog items and vice-versa, enable linking between different categories

## Acceptance criteria

- [x] A bug offers "Convert to backlog item…", which asks for the target type (epic, story or task) and creates the item with the same title, description, comments and reporter
- [x] A backlog item offers "Convert to bug…", which asks for type and severity and creates the bug the same way
- [x] The new record gets a fresh id in its own store; the original is kept, closed (bug) or dropped (item), with a `duplicates <new ref>` link and a comment naming the new record
- [x] Links and references to the original keep working, and its page shows prominently where it was converted to
- [x] Fields with no equivalent in the other store (severity, points, phase, due) are not lost silently: their values are listed in the conversion comment on the new record
- [x] Cancelling the dialog creates nothing; if writing the new record fails, the original is left unchanged

## History

- 2026-10-06 · norman_agent · status: draft -> refined
- 2026-10-12 · norman_agent · status: refined -> in-progress
- 2026-10-12 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-12 · norman_agent · status: in-progress -> review
- 2026-10-12 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-06T01:56Z · norman_agent

Refined: 6 criteria, 5 points, under EPIC-0019. "Enable linking between
categories" already works: links take a prefixed target (`implements STORY-0007`
from a bug), and the link adder from BUG-0011 searches both stores. So this story
is about the conversion itself. I chose to keep the original record, closed or
dropped with a `duplicates` link, rather than delete it, so its id and every
reference to it stay meaningful.

### 2026-10-12T14:07Z · norman_agent (status: in-progress -> review)

Built in 6236a5a. All six criteria are met.

- **From a bug:** *Convert to backlog item…* asks for epic, story or task.
- **From an item:** *Convert to bug…* asks for bug, regression or chore, and a
  severity.
- **How it's written:** `POST /api/convert`, one act, new record first. A
  fresh id in the other store, with title, description, reporter, assignee,
  labels, subsystem, custom fields the target type also has, the whole comment
  thread and the `## History`. An item's acceptance criteria go into the
  bug's description under their own heading.
- **Nothing lost silently:** the new record gets a conversion comment listing
  "Values with no field here": severity, type, status, points, phase, due,
  parent (as `EPIC-0019`, not a bare number) and custom fields the target
  lacks.
- **The original:** closed (bug) or dropped (item), `duplicates <new ref>`,
  a `converted_to` line, a History line, and a comment naming the new record.
  Its page shows a banner, "Converted to STORY-0025", with a link; the new one
  shows "Converted from BUG-0017".
- **If it fails:** a cancelled dialog creates nothing. If the new record cannot
  be written, nothing has touched the original, because it is written second.

I also fixed a bug from EPIC-0003: the item page's full record (`FullItem`)
didn't carry `fields`, so the item page redrew custom fields empty after
every save, even though the file was right.

Checked in Edge on a scratch store: BUG-0017 → STORY-0025. The page followed
to the story, both banners showed, and the link worked. STORY-0006 (with
comments and history) → BUG-0019 as a regression/high, through the API, with
the thread, the history and the leftovers listed. DOM 160/160, UI 218/218,
tracker 34/34.
