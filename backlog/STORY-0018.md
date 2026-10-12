---
id: 18
type: story
title: "Make the built-in workflow moves configurable"
status: review
parent: 17
phase:
assignee: norman
reporter: norman
due:
points: 5
subsystem: unsorted
labels: []
links: [requires 23]
created: 2026-10-05
updated: 2026-10-12T13:54Z
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

_Revised 2026-10-11: the behaviour of a move is modelled as a flow in
FlexDesk's outline editor (`@flexdesk/flow`, FlexDesk 0.6.0+). The editor only
edits: BugDesk supplies the step catalogue, stores the flows and runs them. The
list of moves stays a plain table (status → label → target), because that is a
state machine, not a step flow._

## Acceptance criteria

- [x] In settings, the moves are a plain table per type (from status, label, target status) that can be added to, removed, renamed and reordered, separately for bugs and each backlog type
- [x] Each move can have a flow, opened from its row in FlexDesk's outline editor (`@flexdesk/flow`)
- [x] The step catalogue offers: require a message, prompt for input (text or choice), set a field, clear a field, add a comment, and *If … otherwise* on a condition over the record's fields; loops and parallel blocks are not offered
- [x] A move's flow runs in the same save as the move and is all-or-nothing: cancelling a prompt, or a failing step, leaves the record unchanged
- [x] Example works end to end: a move whose flow has one "Clear field: assignee" step leaves the record with `assignee:` empty, and a `## History` line records the change
- [x] The Action buttons on the record page and the right-click menus on the lists offer the same configured moves
- [x] With no configuration in `.bugdesk/project.json`, every move, label and message rule behaves exactly as today
- [x] A flow or move naming an unknown field or status, or a target outside the type's ladder, cannot be saved, and the problems show in the editor's findings strip with *Go to it*
- [x] The /bugs and /backlog skills say that flows run only for moves made in BugDesk, and how an agent reads a move's configured steps from `project.json` to apply them by hand

## History

- 2026-10-05 · norman_agent · status: draft -> refined
- 2026-10-12 · norman_agent · status: refined -> in-progress
- 2026-10-12 · norman_agent · assignee: (unset) -> norman_agent
- 2026-10-12 · norman_agent · status: in-progress -> review
- 2026-10-12 · norman_agent · assignee: norman_agent -> norman

## Comments

### 2026-10-05T21:14Z · norman_agent

Refined: 7 criteria, 8 points, under EPIC-0017. I read "clear the assignee
when changing phases" as clearing it on a status move (open -> investigation,
or a backlog item -> review). If you also meant the backlog `phase:` field
changing, say so and I'll add a criterion for field-change triggers. The steps
here (set or clear a field, require a message) are the same ones STORY-0007's
custom actions will chain together.

### 2026-10-11T13:39Z · norman_agent

Re-refined for FlexDesk 0.7.0's flow editor, as you suggested: 9 criteria,
down from 8 points to 5. The moves stay a simple table; what a move does is a
flow in the outline editor, with our own step catalogue and no loops. The editor
is FlexDesk's, so we only build the catalogue, the storage and the runner. The
new last criterion covers a gap: agents edit the files directly, so a flow never
runs for them, and the skills have to say so. Requires STORY-0023, the 0.7.0
upgrade.

### 2026-10-12T13:54Z · norman_agent (status: in-progress -> review)

Built in 00613af. All nine criteria are met.

- **The table:** Settings › General › Project › **Edit workflow…** shows one
  move table for bugs and one per backlog type. Each row has From (or "Any
  status"), Move, To, Message, and Flow, with reorder and remove. "Customise
  the moves" starts a table from the built-in moves, and "Back to the built-in
  moves" drops it. Saved under `workflow` in `.bugdesk/project.json`.
- **A move's flow:** the Flow button opens the move's flow in FlexDesk's
  outline editor (`@flexdesk/flow`). The steps are: require a message, ask for
  input (text or a choice), set a field, clear a field, add a comment, and
  *If … otherwise* on a field. There are no loops and no parallel blocks.
  "Insert a value" offers earlier answers (`${input.<step>}`) and the record's
  fields (`${record.<field>}`).
- **All or nothing:** a move's flow runs in the page and only *collects*. The
  move is then one save: status, fields and comment together. Cancelling a
  prompt or a message writes nothing. The backlog patch now carries the move's
  comment too, so a backlog move with a message is also a single write.
- **Checked twice:** a step naming an unknown field or status, a reference to
  a step that isn't there, a choice without choices, or a target off the
  type's ladder. The editor shows these on the step in its findings strip with
  *Go to it*, and Done is refused. The bridge checks again on save and refuses
  the whole workflow, listing every problem.
- **Same moves everywhere:** the bug page and the item page Action buttons, the
  bug queue's right-click menu, and the board's right-click menu, which is new.
- **No configuration:** every move, label and message rule is as before. Tests
  cover this, and the existing move tests pass unchanged.
- **Skills:** flows run only for moves made in BugDesk, and an agent moving a
  record by hand applies the flow itself. The /bugs section says how; /backlog
  points to it.

Checked in Edge on a scratch store:
- Story "Start work" with a "Clear field: assignee" flow left STORY-0006 with
  `assignee:` empty and wrote `- … · assignee: norman -> (unset)`.
- Bug "Hand to testing" with a question and an "add comment" step asked
  "What should be tested?" and wrote "To test: the picker window" as the move's
  comment.
- Cancelling a required message left the bug unchanged.
- A save naming a field `nope` and a target `closed` on a story was refused
  with both problems.

DOM 157/157 (7 new workflow tests), UI 218/218, tracker 34/34.
