---
id: 28
type: story
title: "Manage flows on their own, and pick them from a move or an action"
status: in-progress
parent: 17
phase:
assignee: norman_agent
reporter: norman
due:
points: 5
subsystem: workflow
labels: [workflow, settings]
links: [relates-to STORY-0018, relates-to STORY-0007]
created: 2026-10-14
updated: 2026-10-14T06:23Z
---

## Description

Today a flow belongs to one move or action and is edited only from its row in
Edit workflow. Flows should be things of their own, managed in Settings under
a separate **Flows** entry in the settings sidebar, and a move or an action
should refer to one by name, found by searching, while still being able to
create a new one on the spot.

Reported with it: clicking "Add a step" in the flow editor opens the step menu
BEHIND the flow window. That is FlexDesk's: its flow popovers sit below managed
windows (FlexDesk BUG-0002, `../FlexDesk/bugs/BUG-0002.md`). BugDesk's part is
taking the fixed release.

## Acceptance criteria

- [ ] Settings has a **Flows** entry in its sidebar; it opens a list of the project's flows (name, store, steps, where each is used) to add, rename, edit and remove
- [ ] A flow in use cannot be removed until nothing refers to it, and the list says what uses it
- [ ] In Edit workflow, a move's or an action's flow is chosen from a searchable list of the store's flows, with "New flow" to make one there and then, and an edit button for the chosen one
- [ ] A flow used by a move cannot move to a status (only an action may), and a flow is checked against the fields of every table that uses it; saving refuses with the problem named
- [ ] Existing flows stored inside a move or action keep working, and become named flows the first time the workflow is saved
- [ ] The flow editor's window is titled "Flow — <flow name>"
- [ ] "Add a step" opens its menu in front of the flow editor

## History

- 2026-10-14 · norman_agent · status: draft -> in-progress
- 2026-10-14 · norman_agent · assignee: -> norman_agent
