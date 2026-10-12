---
id: 7
type: story
title: "Add custom actions"
status: review
parent: 17
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: unsorted
labels: []
links: [requires 18, requires 24]
created: 2026-10-05
updated: 2026-10-12T13:58Z
---

## Description

Per ticket type, allow custom actions.

What comes to mind: "Blocked" - This action changes the ticket status to blocked and prompts the user to make an input. This obviously is a simple sequence. I think the ../EcoSim has something like a configuration ui for sequences for the ETL feature? Or ../EcoAgent
  So - we reference things we can do anyway: change status, prompt user for input and store as comment type xy -- and then we make them sequentiable in our editor. Of course also conditions need to be supported. Loops not.

_Revised 2026-10-11: a custom action is a named flow, edited in FlexDesk's
outline editor with the same step catalogue and the same runner as STORY-0018's
move flows._

## Acceptance criteria

- [x] Per record type, settings list custom actions: a name, the statuses where each is offered, and a flow edited in FlexDesk's outline editor
- [x] Actions use STORY-0018's step catalogue (change status, set or clear a field, prompt for input, add a comment, *If … otherwise*); loops are not offered
- [x] A step can use the input from an earlier prompt through the editor's value references (e.g. a comment body containing the reason that was asked for)
- [x] Custom actions appear next to the built-in moves, in the Action buttons and the right-click menus
- [x] An action is all-or-nothing: cancelling a prompt, or a failing step, leaves the record unchanged
- [x] Example works end to end: "Blocked" asks for a reason, adds it as a comment tagged blocked, and moves the record to the custom `blocked` status (STORY-0024)
- [x] An action that names an unknown field or status cannot be saved, and the problems show in the findings strip

## History

- 2026-10-06 · norman_agent · status: draft -> refined
- 2026-10-12 · norman_agent · status: refined -> in-progress
- 2026-10-12 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-12 · norman_agent · status: in-progress -> review
- 2026-10-12 · norman_agent · assignee: norman_agent -> norman

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

### 2026-10-12T13:58Z · norman_agent (status: in-progress -> review)

Built in 5cc8a75. All seven criteria are met.

- **Where to set them up:** Settings › Workflow has an **Actions** group, one
  list per record type. An action has a name, the statuses it is offered in
  (empty means every status), and a flow edited in the same outline editor as
  a move's.
- **Steps:** STORY-0018's catalogue (require a message, ask for input, set or
  clear a field, add a comment, If … otherwise) plus **Move to a status**. That
  step is only offered in an action, since a move already is a status change.
  No loops.
- **Answers in later steps:** "Insert a value" offers earlier answers as
  `${input.<step>}`, which is how the comment carries the reason.
- **Where they show:** after the moves on the bug page and the item page, and
  in the bug queue's and board's right-click menus.
- **All or nothing:** the flow collects, then one save. A cancelled question
  saves nothing.
- **Validation:** an action naming an unknown status (in "offered in" or a Move
  step) or an unknown field is refused, with the steps marked. The editor shows
  this in its findings strip, and the bridge refuses the save.

**The example,** on a scratch copy of the store: `blocked` added to bugs as a
custom status (waiting, after investigation), plus a **Blocked** action offered
in open/investigation/testing (ask "What is it blocked on?", add the comment
"Blocked: ${input.reason}" tagged `blocked`, move to `blocked`). On
BUG-0016 it asked the question, then saved
`### … · norman (status: open -> blocked)` with "Blocked: the vendor API",
the History line, and `status: blocked`, all in one write. When the action
also changes status, the comment's note is that move (`status: open ->
blocked`), since a comment holds one note. The `blocked` tag is used when
an action comments without moving.

I have **not** added `blocked` or the Blocked action to this repo's own
`.bugdesk/project.json`, because that is the shared config of your real
store. Say if you want it, and I'll add it.

DOM 158/158 (one new action test), UI 218/218, tracker 34/34.
