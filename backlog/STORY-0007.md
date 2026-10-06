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
points: 8
subsystem: unsorted
labels: []
links: []
created: 2026-10-05
updated: 2026-10-06T01:56Z
---

## Description

Per ticket type, allow custom actions.

What comes to mind: "Blocked" - This action changes the ticket status to blocked and prompts the user to make an input. This obviously is a simple sequence. I think the ../EcoSim has something like a configuration ui for sequences for the ETL feature? Or ../EcoAgent
  So - we reference things we can do anyway: change status, prompt user for input and store as comment type xy -- and then we make them sequentiable in our editor. Of course also conditions need to be supported. Loops not.

## Acceptance criteria

- [ ] Per record type, settings define custom actions: a name, the statuses where each is offered, and an ordered list of steps
- [ ] Available steps: change status, set or clear a field (custom fields included), prompt the user for input (text or choice), and add a comment of a chosen kind containing that input
- [ ] A step can carry a condition, written in the filter editor's condition language; loops are not supported
- [ ] Custom actions appear next to the built-in moves, in the Action buttons and the right-click menus
- [ ] An action is all-or-nothing: cancelling a prompt, or a failing step, leaves the record unchanged
- [ ] Example works end to end: "Blocked" asks for a reason, adds it as a comment tagged blocked, and sets the `blocked` label
- [ ] A configuration that names an unknown field or status is refused when saved, with a message naming the step

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
