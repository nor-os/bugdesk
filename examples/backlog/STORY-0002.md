---
id: 2
type: story
title: "See the whole backlog as one indented tree"
status: in-progress
parent: 1
phase:
assignee: agent
points: 5
subsystem: backlog
labels: []
links: []
created: 2026-09-01
updated: 2026-09-09
---

## Description

The hierarchy is the point: an epic means nothing without the stories under it.
One scrollable, sortable list with the depth shown as indentation beats a
collapsible outline that has to be re-expanded on every visit.

## Acceptance criteria

- [x] Epics, their stories and their tasks render in one list, in tree order
- [x] Depth is visible at a glance without expanding anything
- [ ] Filtering to a view keeps the ancestors of every match as context
- [ ] Clicking a row opens that item in a tab of the tile it came from

## Comments

### 2026-09-09 · agent

Tree order is computed server-side — depth is a function of the whole store, so
doing it in the client means every consumer re-derives it and gets to disagree
about orphans.
