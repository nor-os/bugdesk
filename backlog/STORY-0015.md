---
id: 15
type: story
title: "Hide optional built-in fields per record type"
status: review
parent: 3
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-12T13:40Z
---

## Description

Not every project needs every built-in field. Per record type, the settings let
you hide the built-in fields that aren't truly mandatory (severity, subsystem,
labels, points, due, phase and similar), and switch off the functions that use
them. Mandatory fields such as id, title, status, created and updated can't be
hidden. Hiding a field is display-only: values already stored in the records
stay in the files untouched.

## Acceptance criteria

- [x] In settings, per record type, each optional built-in field can be hidden; id, title, status, type, created and updated cannot be
- [x] A hidden field disappears from the record page, the new and edit forms, the column chooser, the filter editor and the sort options for that type
- [x] Functions built on a hidden field are switched off with it (e.g. hiding `due` removes the overdue highlighting, hiding `points` removes the estimate check)
- [x] Hiding a field never removes or rewrites its values in the record files; showing it again brings the values back as they were
- [x] The setting is stored in `.bugdesk/project.json` and is shared like the schema

## History

- 2026-10-05 · norman_agent · status: draft -> refined
- 2026-10-12 · norman_agent · status: refined -> in-progress
- 2026-10-12 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-12 · norman_agent · status: in-progress -> review
- 2026-10-12 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-05T21:14Z · norman_agent

Refined: 5 criteria, 5 points, under EPIC-0003. One open point for review: the
refinement check "has an estimate" depends on `points`. Criterion 3 says hiding
`points` switches that check off. Change it if you'd rather keep the check.

### 2026-10-12T13:40Z · norman_agent (status: in-progress -> review)

Built in 04b5a11. All five criteria are met. One note on the column chooser
criterion follows.

- **Settings › Record types:** each type gets a "Built-in fields shown" list.
  The hideable fields are severity, subsystem, labels and links for bugs, and
  phase, due, points, subsystem, labels and links for backlog items. id,
  title, status, type, created and updated cannot be hidden. Neither can
  assignee, reporter or parent, because the claim, the handback and the tree
  depend on them.
- **Where a hidden field goes:** it leaves the record page, New item and the
  filter editor's field list for that type. A list with several types in it
  only drops a field that **every** type hides, so a Chore still shows
  Subsystem when only Bug hides it. A saved filter on a hidden field keeps
  working.
- **What switches off with it:** hiding `due` turns off overdue highlighting
  and the "due soon" state. Hiding `points` drops the estimate check from
  refinement.
- **Values stay in the files.** A hidden field is not sent on save, so its
  value is left exactly as it was and comes back when shown again.

On "the column chooser": BugDesk has none yet. The board drops its Pts, Phase
and Due columns when every type hides them, and sorting is by column, so a
column that isn't there can't be sorted on. The chooser itself comes with
STORY-0016's custom-field columns. It is being added to FlexDesk's DataTable
(FlexDesk STORY-0012, `../FlexDesk/backlog/STORY-0012.md`).
