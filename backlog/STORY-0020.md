---
id: 20
type: story
title: "Auto-save record edits"
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
created: 2026-10-06
updated: 2026-10-13T04:39Z
---

## Description

Split out of STORY-0006. Optionally, record edits are saved without pressing
Save, either at a fixed interval or a short while after typing stops (debounced),
with retries that back off exponentially when a save fails. The Save buttons,
their labels and the saved-status indicator change to match the mode.

## Acceptance criteria

- [x] Settings offer auto-save off (the default, as today), at a fixed interval in seconds, or debounced: a set time after the last keystroke
- [x] With auto-save on, an edited record saves without pressing Save; the Save button and its label adapt (e.g. "Save now")
- [x] The status shows Unsaved, Saving…, Saved at hh:mm or Save failed, matching what is actually on disk
- [x] A failed save retries with exponential backoff (2 s, 4 s, 8 s … capped at 60 s) and nothing typed is lost meanwhile
- [x] If the file changed on disk since it was opened, auto-save does not overwrite it; it stops and shows the conflict
- [x] With STORY-0006's commit-after-save on, auto-save does not commit every save: it commits once the record is left or after 5 minutes without edits

## History

- 2026-10-06 · norman_agent · status: draft -> refined
- 2026-10-13 · norman_agent · status: refined -> in-progress
- 2026-10-13 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-13 · norman_agent · status: in-progress -> review
- 2026-10-13 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-06T01:56Z · norman_agent

Refined: 6 criteria, 5 points, under EPIC-0019, split out of STORY-0006. Check
criterion 6: the batching rule (commit when leaving the record, or after 5 quiet
minutes) is my proposal, so that auto-save does not flood git with commits.

### 2026-10-13T04:39Z · norman_agent (status: in-progress -> review)

Built in ca4a283. All six criteria are met.

- **Settings › Saving and git…** offers three options: *Only when I press
  Save* (the default, as today), *A few seconds after I stop typing*
  (debounced), and *Every few seconds while there are edits* (interval). You
  also choose the number of seconds. Stored in `git` in
  `.bugdesk/project.json`, beside the commit and push switches.
- **On the page:** with auto-save on, an edited bug or item saves by itself,
  and Save reads **Save now**. Beside it: Unsaved, Saving…, Saved at hh:mm,
  or Save failed — retrying in N s. An auto-save does not redraw the form, so
  nothing being typed is lost, and the page stays dirty if more was typed
  while the save was on the wire.
- **Retries:** after 2, 4, 8, 16, 32 s, then every 60 s, sending everything
  typed so far.
- **Conflicts:** each auto-save names the version it started from. If the file
  changed on disk since (an agent, a pull), the bridge answers 409, auto-save
  stops, and the state says "changed on disk since it was opened". Nothing is
  overwritten.
- **Commits:** auto-saves write without committing. Leaving the record (or
  five minutes with no edit) settles it: one commit, if commit-after-save is
  on.

Checked in Edge on a scratch store:
- Debounced at 1 s, an edit to Subsystem saved itself ("Saved at 06:36"),
  and the field kept its text.
- An external edit made through the API, then another edit on the page,
  showed the conflict, and the external labels survived on disk.
- In a scratch git repo: two auto-saves made no commit, then the settle made
  exactly one.

Along the way I fixed the page counting its own fill of the labels at load as
an edit, which made the state read "Unsaved" on a page nobody had touched.
DOM 164/164 (4 new auto-save tests), UI 218/218, tracker 34/34.
