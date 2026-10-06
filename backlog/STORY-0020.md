---
id: 20
type: story
title: "Auto-save record edits"
status: draft
parent: 19
phase:
assignee:
reporter: norman
due:
points:
subsystem: unsorted
labels: []
links: []
created: 2026-10-06
updated: 2026-10-06T01:55Z
---

## Description

Split out of STORY-0006. Optionally, record edits are saved without pressing
Save, either at a fixed interval or a short while after typing stops (debounced),
with retries that back off exponentially when a save fails. The Save buttons,
their labels and the saved-status indicator change to match the mode.

## Acceptance criteria

_(not refined yet)_
