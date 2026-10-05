---
id: 18
type: story
title: "Make the built-in workflow moves configurable"
status: draft
parent: 17
phase:
assignee:
reporter: norman
due:
points:
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-05T21:12Z
---

## Description

Today the moves are hard-coded: the bug moves in `ui/js/ticketdesk/bug_transitions.js`,
and the backlog ladders in `backlog_data.js`. A project should be able to change
them in settings: which moves each status offers, their labels, whether a move
needs a message, and the side effects a move has. The motivating example is
clearing the assignee when an item changes phase or status.

The configuration lives in `.bugdesk/project.json`, next to the schema from
EPIC-0003. With no configuration, every move behaves exactly as it does today.
The steps a move can run (set a field, clear a field, require a message) are
the same building blocks STORY-0007's custom actions use.

## Acceptance criteria

_(not refined yet)_
