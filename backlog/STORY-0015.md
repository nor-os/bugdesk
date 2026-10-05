---
id: 15
type: story
title: "Hide optional built-in fields per record type"
status: refined
parent: 3
phase:
assignee:
reporter: norman
due:
points: 5
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-05T21:14Z
---

## Description

Not every project needs every built-in field. Per record type, the settings let
you hide the built-in fields that aren't truly mandatory (severity, subsystem,
labels, points, due, phase and similar), and switch off the functions that use
them. Mandatory fields such as id, title, status, created and updated can't be
hidden. Hiding a field is display-only: values already stored in the records
stay in the files untouched.

## Acceptance criteria

- [ ] In settings, per record type, each optional built-in field can be hidden; id, title, status, type, created and updated cannot be
- [ ] A hidden field disappears from the record page, the new and edit forms, the column chooser, the filter editor and the sort options for that type
- [ ] Functions built on a hidden field are switched off with it (e.g. hiding `due` removes the overdue highlighting, hiding `points` removes the estimate check)
- [ ] Hiding a field never removes or rewrites its values in the record files; showing it again brings the values back as they were
- [ ] The setting is stored in `.bugdesk/project.json` and is shared like the schema

## History

- 2026-10-05 · norman_agent · status: draft -> refined

## Comments

### 2026-10-05T21:14Z · norman_agent

Refined: 5 criteria, 5 points, under EPIC-0003. One open point for review: the
refinement check "has an estimate" depends on `points`. Criterion 3 says hiding
`points` switches that check off. Change it if you'd rather keep the check.
