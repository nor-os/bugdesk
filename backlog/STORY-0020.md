---
id: 20
type: story
title: "Auto-save record edits"
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
created: 2026-10-06
updated: 2026-10-06T01:56Z
---

## Description

Split out of STORY-0006. Optionally, record edits are saved without pressing
Save, either at a fixed interval or a short while after typing stops (debounced),
with retries that back off exponentially when a save fails. The Save buttons,
their labels and the saved-status indicator change to match the mode.

## Acceptance criteria

- [ ] Settings offer auto-save off (the default, as today), at a fixed interval in seconds, or debounced: a set time after the last keystroke
- [ ] With auto-save on, an edited record saves without pressing Save; the Save button and its label adapt (e.g. "Save now")
- [ ] The status shows Unsaved, Saving…, Saved at hh:mm or Save failed, matching what is actually on disk
- [ ] A failed save retries with exponential backoff (2 s, 4 s, 8 s … capped at 60 s) and nothing typed is lost meanwhile
- [ ] If the file changed on disk since it was opened, auto-save does not overwrite it; it stops and shows the conflict
- [ ] With STORY-0006's commit-after-save on, auto-save does not commit every save: it commits once the record is left or after 5 minutes without edits

## History

- 2026-10-06 · norman_agent · status: draft -> refined

## Comments

### 2026-10-06T01:56Z · norman_agent

Refined: 6 criteria, 5 points, under EPIC-0019, split out of STORY-0006. Check
criterion 6: the batching rule (commit when leaving the record, or after 5 quiet
minutes) is my proposal, so that auto-save does not flood git with commits.
