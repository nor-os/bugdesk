---
id: 1
type: story
title: "Add Conversion journeys"
status: refined
parent: 19
phase:
assignee:
reporter: norman
due:
points: 5
subsystem: unsorted
labels: []
links: []
created: 2026-10-02
updated: 2026-10-06T01:56Z
---

## Description

- bugs that are transformed into backlog items and vice-versa, enable linking between different categories

## Acceptance criteria

- [ ] A bug offers "Convert to backlog item…", which asks for the target type (epic, story or task) and creates the item with the same title, description, comments and reporter
- [ ] A backlog item offers "Convert to bug…", which asks for type and severity and creates the bug the same way
- [ ] The new record gets a fresh id in its own store; the original is kept, closed (bug) or dropped (item), with a `duplicates <new ref>` link and a comment naming the new record
- [ ] Links and references to the original keep working, and its page shows prominently where it was converted to
- [ ] Fields with no equivalent in the other store (severity, points, phase, due) are not lost silently: their values are listed in the conversion comment on the new record
- [ ] Cancelling the dialog creates nothing; if writing the new record fails, the original is left unchanged

## History

- 2026-10-06 · norman_agent · status: draft -> refined

## Comments

### 2026-10-06T01:56Z · norman_agent

Refined: 6 criteria, 5 points, under EPIC-0019. "Enable linking between
categories" already works: links take a prefixed target (`implements STORY-0007`
from a bug), and the link adder from BUG-0011 searches both stores. So this story
is about the conversion itself. I chose to keep the original record, closed or
dropped with a `duplicates` link, rather than delete it, so its id and every
reference to it stay meaningful.
