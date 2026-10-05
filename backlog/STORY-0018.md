---
id: 18
type: story
title: "Make the built-in workflow moves configurable"
status: refined
parent: 17
phase:
assignee:
reporter: norman
due:
points: 8
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-05T21:14Z
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

- [ ] In settings, a project can edit the moves each status offers: add, remove, rename and reorder them, and choose each move's target status, separately for bugs and for each backlog type
- [ ] Each move can be set to need a message (a comment) or not, replacing today's fixed rule that every move except "Start investigation" needs one
- [ ] A move can carry side effects that run in the same save: set a field to a value, or clear a field (assignee, phase, due, or a custom field)
- [ ] Example works end to end: a move configured to clear the assignee leaves the record with `assignee:` empty, and a `## History` line records the assignee change
- [ ] The Action buttons on the record page and the right-click menus on the lists always offer the same configured moves
- [ ] With no configuration in `.bugdesk/project.json`, every move, label and message rule behaves exactly as today
- [ ] A configuration that names an unknown status, or a target outside the type's ladder, is refused when saved, with a message naming the move

## History

- 2026-10-05 · norman_agent · status: draft -> refined

## Comments

### 2026-10-05T21:14Z · norman_agent

Refined: 7 criteria, 8 points, under EPIC-0017. I read "clear the assignee
when changing phases" as clearing it on a status move (open -> investigation,
or a backlog item -> review). If you also meant the backlog `phase:` field
changing, say so and I'll add a criterion for field-change triggers. The steps
here (set or clear a field, require a message) are the same ones STORY-0007's
custom actions will chain together.
