---
id: 7
type: story
title: "Add custom actions"
status: refined
parent: 17
phase:
assignee:
reporter: norman
due:
points: 5
subsystem: unsorted
labels: []
links: [requires 18, requires 24]
created: 2026-10-05
updated: 2026-10-12T09:06Z
---

## Description

Per ticket type, allow custom actions.

What comes to mind: "Blocked" - This action changes the ticket status to blocked and prompts the user to make an input. This obviously is a simple sequence. I think the ../EcoSim has something like a configuration ui for sequences for the ETL feature? Or ../EcoAgent
  So - we reference things we can do anyway: change status, prompt user for input and store as comment type xy -- and then we make them sequentiable in our editor. Of course also conditions need to be supported. Loops not.

_Revised 2026-10-11: a custom action is a named flow, edited in FlexDesk's
outline editor with the same step catalogue and the same runner as STORY-0018's
move flows._

## Acceptance criteria

- [ ] Per record type, settings list custom actions: a name, the statuses where each is offered, and a flow edited in FlexDesk's outline editor
- [ ] Actions use STORY-0018's step catalogue (change status, set or clear a field, prompt for input, add a comment, *If … otherwise*); loops are not offered
- [ ] A step can use the input from an earlier prompt through the editor's value references (e.g. a comment body containing the reason that was asked for)
- [ ] Custom actions appear next to the built-in moves, in the Action buttons and the right-click menus
- [ ] An action is all-or-nothing: cancelling a prompt, or a failing step, leaves the record unchanged
- [ ] Example works end to end: "Blocked" asks for a reason, adds it as a comment tagged blocked, and moves the record to the custom `blocked` status (STORY-0024)
- [ ] An action that names an unknown field or status cannot be saved, and the problems show in the findings strip

## History

- 2026-10-06 · norman_agent · status: draft -> refined

## Comments

### 2026-10-06T01:56Z · norman_agent

Refined: 7 criteria, 8 points, under EPIC-0017. Its steps are the same
building blocks as STORY-0018's, so it comes after 0018. One gap: your example
says "change status to blocked", but `blocked` is not a status, and no story
yet makes statuses configurable. For now the example sets a `blocked` label. If
you want real custom statuses, I'll file that as its own story under EPIC-0003.
I'll look at the sequence editors in EcoSim and EcoAgent when the work starts.

### 2026-10-11T13:39Z · norman_agent

Re-refined: custom actions are named flows in FlexDesk's outline editor,
sharing STORY-0018's catalogue and runner. 7 criteria, down from 8 points to 5.
The new criterion 3 uses the editor's value references to carry the prompt's
answer into the comment. Requires STORY-0018. The `blocked` status question
from my last comment is still open.

### 2026-10-12T09:06Z · norman_agent

The "Blocked" example now uses a real `blocked` status from the new STORY-0024
(custom statuses) instead of a label. Requires STORY-0024. Points unchanged.
